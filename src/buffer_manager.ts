import path from "path";

import { debounce } from "lodash-es";
import { Buffer, NeovimClient } from "neovim";
import { ATTACH } from "neovim/lib/api/Buffer";
import {
    CancellationToken,
    CancellationTokenSource,
    Disposable,
    EndOfLine,
    EventEmitter,
    Selection,
    TextDocument,
    TextDocumentContentProvider,
    TextEditor,
    TextEditorLineNumbersStyle,
    TextEditorOptionsChangeEvent,
    TextEditorRevealType,
    Uri,
    ViewColumn,
    commands,
    window,
    workspace,
} from "vscode";

import { config } from "./config";
import { EventBusData, eventBus } from "./eventBus";
import { createLogger } from "./logger";
import { MainController } from "./main_controller";
import { NeovimExtensionRequestProcessable } from "./neovim_events_processable";
import { ManualPromise, callAtomic, convertByteNumToCharNum } from "./utils";

// !Note: document and editors in vscode events and namespace are reference stable
// ! Integration notes:
// ! When opening an editor with a document first time, a buffer is created in neovim along with new window for each buffer
// ! When switching off editor, the buffer is being hidden & unloaded in neovim if it's last visitlbe buffer (see :help bufhidden)

export interface BufferManagerSettings {
    neovimViewportWidth: number;
}

const logger = createLogger("BufferManager");

const BUFFER_NAME_PREFIX = "__vscode_neovim__-";

const BUFFER_SCHEME = "vscode-neovim";

/**
 * Manages neovim buffers and windows and maps them to vscode editors & documents
 */
export class BufferManager implements Disposable, NeovimExtensionRequestProcessable {
    private disposables: Disposable[] = [];
    /**
     * Internal sync promise
     */
    private syncLayoutPromise?: ManualPromise;
    private syncLayoutCancelTokenSource: CancellationTokenSource = new CancellationTokenSource();
    private syncActiveEditorPromise?: ManualPromise;
    /**
     * Text documents originated externally, as consequence of neovim command, like :help or :PlugStatus
     */
    private externalTextDocuments: WeakSet<TextDocument> = new Set();
    /**
     * Mapping of vscode documents -> neovim buffer id
     */
    private textDocumentToBufferId: Map<TextDocument, number> = new Map();
    /**
     * Mapping of vscode "temp" (without viewColumn) editor -> win id
     */
    private textEditorToWinId: Map<TextEditor, number> = new Map();
    /**
     * Mapping of winId -> editor
     */
    private winIdToEditor: Map<number, TextEditor> = new Map();
    /**
     * Current grid configurations
     */
    private grids: Map<number, { winId: number }> = new Map();
    /**
     * Tab configuration for each editor
     */
    private editorTabConfiguration: WeakMap<TextEditor, { tabSize: number; insertSpaces: boolean }> = new WeakMap();
    /**
     * Provider for external buffers' document contents (e.g. `:help`)
     */
    private bufferProvider: BufferProvider;

    /**
     * Buffer event delegate
     */
    public onBufferEvent?: (
        bufId: number,
        tick: number,
        firstLine: number,
        lastLine: number,
        linedata: string[],
        more: boolean,
    ) => void;

    public onBufferInit?: (bufferId: number, textDocument: TextDocument) => void;

    private get client() {
        return this.main.client;
    }

    public constructor(private main: MainController) {
        this.disposables.push(window.onDidChangeVisibleTextEditors(this.onDidChangeVisibleTextEditors));
        this.disposables.push(window.onDidChangeActiveTextEditor(this.onDidChangeActiveTextEditor));
        this.disposables.push(workspace.onDidCloseTextDocument(this.onDidCloseTextDocument));
        this.disposables.push(window.onDidChangeTextEditorOptions(this.onDidChangeEditorOptions));

        this.bufferProvider = new BufferProvider(this.client, this.receivedBufferEvent);
        this.disposables.push(workspace.registerTextDocumentContentProvider(BUFFER_SCHEME, this.bufferProvider));

        eventBus.on("redraw", this.handleRedraw, this, this.disposables);
    }

    public dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }

    public async forceResync(): Promise<void> {
        logger.debug(`force resyncing layout`);
        if (!this.syncLayoutPromise) {
            this.syncLayoutPromise = new ManualPromise();
        }
        // this.cancelTokenSource will always be cancelled when the visible editors change
        await this.syncLayoutDebounced(this.syncLayoutCancelTokenSource.token);
        await this.syncActiveEditorDebounced();
    }

    public async waitForLayoutSync(): Promise<void> {
        if (this.syncLayoutPromise) {
            logger.debug(`Waiting for completing layout resyncing`);
            await this.syncLayoutPromise.promise;
            logger.debug(`Waiting done`);
        }
    }

    public getTextDocumentForBufferId(id: number): TextDocument | undefined {
        const doc = [...this.textDocumentToBufferId].find(([, bufId]) => id === bufId)?.[0];
        return doc && !doc.isClosed ? doc : undefined;
    }

    public getBufferIdForTextDocument(doc: TextDocument): number | undefined {
        return this.textDocumentToBufferId.get(doc);
    }

    public getGridIdForWinId(winId: number): number | undefined {
        const grid = [...this.grids].reverse().find(([, conf]) => conf.winId === winId);
        return grid ? grid[0] : undefined;
    }

    public getWinIdForGridId(gridId: number): number | undefined {
        return this.grids.get(gridId)?.winId;
    }

    public getWinIdForTextEditor(editor: TextEditor): number | undefined {
        return this.textEditorToWinId.get(editor);
    }

    public getEditorFromWinId(winId: number): TextEditor | undefined {
        // try first noColumnEditors
        const noColumnEditor = [...this.textEditorToWinId].find(([, id]) => id === winId);
        if (noColumnEditor) {
            return noColumnEditor[0];
        }
        return this.winIdToEditor.get(winId);
    }

    public getGridIdFromEditor(editor: TextEditor): number | undefined {
        return this.getGridIdForWinId(this.getWinIdForTextEditor(editor) || 0);
    }

    public getEditorFromGridId(gridId: number): TextEditor | undefined {
        const winId = this.getWinIdForGridId(gridId);
        if (!winId) {
            return;
        }
        return this.getEditorFromWinId(winId);
    }

    public isExternalTextDocument(textDoc: TextDocument): boolean {
        // !Output should be modifiable, vscode treats it as a regular document.
        // !When the option "modifiable" is set to false, nvim_buf_set_text will not work. #498
        // !Don't remove this, cause it's a long time bug
        if (textDoc.uri.scheme === "output") {
            return false;
        }
        return this.externalTextDocuments.has(textDoc);
    }

    private handleRedraw(data: EventBusData<"redraw">) {
        for (const { name, args } of data) {
            switch (name) {
                case "win_external_pos":
                case "win_pos": {
                    for (const [grid, win] of args) {
                        this.grids.set(grid, { winId: win.id });
                    }
                    break;
                }
                case "win_close": {
                    for (const [grid] of args) {
                        this.grids.delete(grid);
                    }
                    break;
                }
            }
        }
    }

    public async handleExtensionRequest(name: string, args: unknown[]): Promise<void> {
        switch (name) {
            case "open-file": {
                const [fileName, close] = args as [string, number | "all"];
                const currEditor = window.activeTextEditor;
                let doc: TextDocument | undefined;
                try {
                    if (fileName === "__vscode_new__") {
                        doc = await workspace.openTextDocument();
                    } else {
                        const normalizedName = fileName.trim();
                        const filePath = this.findPathFromFileName(normalizedName);
                        doc = await workspace.openTextDocument(filePath);
                    }
                } catch (error) {
                    logger.error(`Error opening file ${fileName}, ${error}`);
                }
                if (!doc) {
                    return;
                }
                let viewColumn: ViewColumn | undefined;
                if (close && close !== "all" && currEditor) {
                    viewColumn = currEditor.viewColumn;
                    await commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
                }
                await window.showTextDocument(doc, viewColumn);
                if (close === "all") {
                    await commands.executeCommand("workbench.action.closeOtherEditors");
                }
                break;
            }
            case "external-buffer": {
                const [name, idStr, expandTab, tabStop] = args as [string, string, number, number, number];
                if (name.startsWith(`${BUFFER_NAME_PREFIX}output:`)) {
                    break;
                }
                const id = parseInt(idStr, 10);
                if (!(name && this.isVscodeUriName(name))) {
                    logger.debug(`Attaching new external buffer: '${name}', id: ${id}`);
                    if (id === 1) {
                        logger.debug(`${id} is the first neovim buffer, skipping`);
                        return;
                    }
                    await this.attachNeovimExternalBuffer(name, id, !!expandTab, tabStop);
                } else if (name) {
                    const normalizedName = name.startsWith(BUFFER_NAME_PREFIX) ? name.substring(18) : name;
                    logger.debug(`Buffer request for ${normalizedName}, bufId: ${idStr}`);
                    try {
                        let doc = this.findDocFromUri(normalizedName);
                        if (!doc) {
                            logger.debug(`Opening a doc: ${normalizedName}`);
                            doc = await workspace.openTextDocument(Uri.parse(normalizedName, true));
                        }
                        let forceTabOptions = false;
                        if (!this.textDocumentToBufferId.has(doc)) {
                            logger.debug(`No doc -> buffer mapping exists, assigning mapping and init buffer options`);
                            const buffers = await this.client.buffers;
                            const buf = buffers.find((b) => b.id === id);
                            if (buf) {
                                forceTabOptions = true;
                                await this.initBufferForDocument(doc, buf);
                            }
                            this.textDocumentToBufferId.set(doc, id);
                        }
                        if (window.activeTextEditor?.document !== doc) {
                            // this.skipJumpsForUris.set(normalizedNamee, true);
                            const editor = await window.showTextDocument(doc, {
                                // viewColumn: vscode.ViewColumn.Active,
                                // !need to force editor to appear in the same column even if vscode 'revealIfOpen' setting is true
                                viewColumn: window.activeTextEditor
                                    ? window.activeTextEditor.viewColumn
                                    : ViewColumn.Active,
                                preserveFocus: false,
                                preview: false,
                            });
                            this.editorTabConfiguration.set(editor, {
                                insertSpaces: editor.options.insertSpaces as boolean,
                                tabSize: editor.options.tabSize as number,
                            });
                            if (forceTabOptions) {
                                await this.resyncBufferTabOptions(editor, id);
                            }
                        }
                    } catch {
                        // todo: show error
                    }
                }
                break;
            }
            case "window-changed": {
                this.onWindowChangedDebounced(args[0] as number);
                break;
            }
        }
    }

    private onWindowChanged = async (winId: number): Promise<void> => {
        logger.debug(`onWindowChanged, target window id: ${winId}`);

        const returnToActiveEditor = async () => {
            if (window.activeTextEditor) {
                await window.showTextDocument(window.activeTextEditor.document, window.activeTextEditor.viewColumn);
            }
        };

        let targetEditor = this.getEditorFromWinId(winId);
        if (!targetEditor) {
            logger.debug(`target editor not found <check 1>, return to active editor`);
            await returnToActiveEditor();
            return;
        }
        if (window.activeTextEditor === targetEditor) return;
        // since the event could be triggered by vscode side operations
        // we need to wait a bit to let vscode finish its internal operations
        // then check if the target editor is still the same
        await new Promise((res) => setTimeout(res, 50));
        this.syncLayoutPromise && (await this.syncLayoutPromise.promise);
        this.syncActiveEditorPromise && (await this.syncActiveEditorPromise.promise);
        // triggered by vscode side operations
        if (window.activeTextEditor === undefined) {
            // e.g. open settings, open keyboard shortcuts settings which overrides active editor
            logger.debug(`activeTextEditor is undefined, skipping`);
            return;
        }
        await this.main.cursorManager.waitForCursorUpdate(window.activeTextEditor);
        const { id: curwin } = await this.client.getWindow();
        targetEditor = this.getEditorFromWinId(curwin);
        if (!targetEditor) {
            logger.debug(`target editor not found <check 2>, return to active editor`);
            returnToActiveEditor();
            return;
        }
        if (window.activeTextEditor === targetEditor) return;
        await this.main.cursorManager.waitForCursorUpdate(targetEditor);
        const uri = targetEditor.document.uri;
        const { scheme } = uri;
        switch (scheme) {
            case "output": {
                await commands.executeCommand("workbench.panel.output.focus");
                return;
            }

            case "vscode-notebook-cell": {
                const targetNotebook = window.visibleNotebookEditors.find((e) => e.notebook.uri.fsPath === uri.fsPath);
                if (targetNotebook) {
                    // 1. jump to target notebook
                    await window.showTextDocument(targetEditor.document, targetNotebook.viewColumn);
                    // wait a bit to let vscode finish its internal operations
                    await new Promise((res) => setTimeout(res, 50));
                    // 2. jump to target cell
                    await window.showTextDocument(targetEditor.document, targetEditor.viewColumn);
                    return;
                }
                break;
            }

            default: {
                await window.showTextDocument(targetEditor.document, targetEditor.viewColumn);
                return;
            }
        }

        // Should not happen
        await returnToActiveEditor();
    };

    private onWindowChangedDebounced = debounce(this.onWindowChanged, 100, { leading: false, trailing: true });

    /**
     * !Note when closing text editor with document, vscode sends onDidCloseTextDocument first
     * @param doc
     */
    private onDidCloseTextDocument = (_doc: TextDocument): void => {
        // Don't need to do anything here
        // Regardless of whether the document was previously visible or not,
        // it will always be cleaned up properly in syncLayout.
        /*
        const hasVisibleEditor = !!this.openedEditors.find((d) => d.document === doc);
        // we'll handle it in onDidChangeVisibleTextEditors()
        if (!hasVisibleEditor) {
            // const bufId = this.textDocumentToBufferId.get(doc);
            this.textDocumentToBufferId.delete(doc);
            // buffer unloading breaks jumplist https://github.com/asvetliakov/vscode-neovim/issues/350
            // if (bufId) {
            //     this.unloadBuffer(bufId);
            // }
        }
        */
    };

    private onDidChangeVisibleTextEditors = (): void => {
        // !since onDidChangeVisibleTextEditors/onDidChangeActiveTextEditor are synchronyous
        // !and we debounce this event, and possible init new buffers in neovim in async way
        // !we need to wait to complete last call before processing onDidChangeActiveTextEditor
        // !for this init a promise early, then resolve it after processing
        logger.debug(`onDidChangeVisibleTextEditors`);
        if (!this.syncLayoutPromise) {
            this.syncLayoutPromise = new ManualPromise();
        }

        // Cancel the previous syncLayout call, and then create a new token source for the new
        // syncLayout call
        this.syncLayoutCancelTokenSource.cancel();
        this.syncLayoutCancelTokenSource = new CancellationTokenSource();
        this.syncLayoutDebounced(this.syncLayoutCancelTokenSource.token);
    };

    private onDidChangeActiveTextEditor = (): void => {
        logger.debug(`onDidChangeActiveTextEditor`);
        if (!this.syncActiveEditorPromise) {
            this.syncActiveEditorPromise = new ManualPromise();
        }
        this.syncActiveEditorDebounced();
    };

    private syncLayout = async (cancelToken: CancellationToken): Promise<void> => {
        logger.debug(`syncing layout`);
        // store in copy, just in case
        const currentVisibleEditors = [...window.visibleTextEditors];

        // Open/change neovim windows
        logger.debug(`new/changed editors/windows`);
        for (const visibleEditor of currentVisibleEditors) {
            logger.debug(
                `Visible editor, viewColumn: ${
                    visibleEditor.viewColumn
                }, doc: ${visibleEditor.document.uri.toString()}`,
            );
            // create buffer first if not known to the system
            // creating initially not listed buffer to prevent firing autocmd events when
            // buffer name/lines are not yet set. We'll set buflisted after setup
            if (!this.textDocumentToBufferId.has(visibleEditor.document)) {
                logger.debug(`Document not known, init in neovim`);
                const buf = await this.client.createBuffer(false, true);
                if (typeof buf === "number") {
                    logger.error(`Cannot create a buffer, code: ${buf}`);
                    continue;
                }
                await this.initBufferForDocument(visibleEditor.document, buf, visibleEditor);

                logger.debug(`Document: ${visibleEditor.document.uri.toString()}, BufId: ${buf.id}`);
                this.textDocumentToBufferId.set(visibleEditor.document, buf.id);
            }
            // editor wasn't changed, skip
            // !Note always sync opened editors, it doesn't hurt and and solves the curious problem when there are
            // !few visible editors with same viewColumn (happens when you open search editor, when jump to a file from it)
            // if (prevVisibleEditors.includes(visibleEditor)) {
            //     logger.debug(`Editor wasn't changed, skip`);
            //     if (visibleEditor.viewColumn) {
            //         keepViewColumns.add(visibleEditor.viewColumn);
            //     }
            //     continue;
            // }
            const editorBufferId = this.textDocumentToBufferId.get(visibleEditor.document)!;
            let winId: number | undefined;
            try {
                if (!this.textEditorToWinId.has(visibleEditor)) {
                    logger.debug(
                        `Creating new neovim window for ${visibleEditor.viewColumn} column (undefined is OK here)`,
                    );
                    winId = await this.createNeovimWindow(editorBufferId);
                    logger.debug(`Created new window: ${winId}`);
                    logger.debug(`ViewColumn: ${visibleEditor.viewColumn} - WinId: ${winId}`);
                    this.textEditorToWinId.set(visibleEditor, winId);
                    this.winIdToEditor.set(winId, visibleEditor);
                    this.main.cursorManager.updateNeovimCursorPosition(visibleEditor, visibleEditor.selection.active);
                }
            } catch (e) {
                logger.error(`${(e as Error).message}`);
                continue;
            }
        }

        logger.debug(`Clean up windows and buffers`);
        const unusedWindows: number[] = [];
        const unusedBuffers: number[] = [];
        // close windows
        [...this.textEditorToWinId.entries()].forEach(([editor, winId]) => {
            if (!currentVisibleEditors.includes(editor)) {
                logger.debug(`Editor viewColumn: ${editor.viewColumn}, winId: ${winId}, closing`);
                this.textEditorToWinId.delete(editor);
                this.winIdToEditor.delete(winId);
                unusedWindows.push(winId);
            }
        });
        // delete buffers
        [...this.textDocumentToBufferId.entries()].forEach(([document, bufId]) => {
            if (!currentVisibleEditors.some((editor) => editor.document === document) && document.isClosed) {
                logger.debug(`Document: ${document.uri.toString()}, bufId: ${bufId}, deleting`);
                this.textDocumentToBufferId.delete(document);
                unusedBuffers.push(bufId);
            }
        });
        unusedBuffers.length &&
            (await this.client.executeLua("require'vscode-neovim.api'.delete_buffers(...)", [unusedBuffers]));
        unusedWindows.length &&
            (await this.client.executeLua("require'vscode-neovim.api'.close_windows(...)", [unusedWindows]));

        if (cancelToken.isCancellationRequested) {
            // If the visible editors has changed since we started, don't resolve the promise,
            // because syncActiveEditor assumes that this promise is only resolved when the
            // layout is synced, and currently the layout is synced based on outdated data
            logger.debug(`Cancellation requested in syncLayout, returning`);
            return;
        }

        this.syncLayoutPromise?.resolve();
        this.syncLayoutPromise = undefined;
    };

    // ! we're interested only in the editor final layout and vscode may call this function few times, e.g. when moving an editor to other group
    // ! so lets debounce it slightly
    private syncLayoutDebounced = debounce(this.syncLayout, 200, { leading: false, trailing: true });

    private syncActiveEditor = async (): Promise<void> => {
        logger.debug(`syncing active editor`);
        await this.waitForLayoutSync();

        const finish = () => {
            this.syncActiveEditorPromise?.resolve();
            this.syncActiveEditorPromise = undefined;
        };

        const activeEditor = window.activeTextEditor;
        if (!activeEditor) {
            finish();
            return;
        }
        const winId = this.textEditorToWinId.get(activeEditor);
        if (!winId) {
            // If we reach here, then the current window in Neovim is out of sync with the
            // active editor, which manifests itself as the editor being completely unresponsive
            // when in normal mode
            logger.error(
                `Unable to determine neovim windows id for editor viewColumn: ${
                    activeEditor.viewColumn
                }, docUri: ${activeEditor.document.uri.toString()}`,
            );

            finish();
            return;
        }
        logger.debug(`Setting active editor - viewColumn: ${activeEditor.viewColumn}, winId: ${winId}`);
        await this.main.cursorManager.updateNeovimCursorPosition(activeEditor, activeEditor.selection.active);
        try {
            await this.client.request("nvim_set_current_win", [winId]);
        } catch (e) {
            logger.error(`${(e as Error).message}`);
        }

        finish();
    };

    private syncActiveEditorDebounced = debounce(this.syncActiveEditor, 100, { leading: false, trailing: true });

    private onDidChangeEditorOptions = (e: TextEditorOptionsChangeEvent): void => {
        logger.debug(`Received onDidChangeEditorOptions`);
        const bufId = this.textDocumentToBufferId.get(e.textEditor.document);
        if (!bufId) {
            logger.warn(`No buffer for onDidChangeEditorOptions, skipping`);
            return;
        }
        const prevOptions = this.editorTabConfiguration.get(e.textEditor);
        if (
            !prevOptions ||
            prevOptions.insertSpaces !== e.options.insertSpaces ||
            prevOptions.tabSize !== e.options.tabSize
        ) {
            logger.debug(`Updating tab options for bufferId: ${bufId}`);
            this.editorTabConfiguration.set(e.textEditor, {
                insertSpaces: e.options.insertSpaces as boolean,
                tabSize: e.options.tabSize as number,
            });
            this.resyncBufferTabOptions(e.textEditor, bufId);
        }
    };

    private receivedBufferEvent = (
        buffer: Buffer,
        tick: number,
        firstLine: number,
        lastLine: number,
        linedata: string[],
        more: boolean,
    ): void => {
        this.onBufferEvent && this.onBufferEvent(buffer.id, tick, firstLine, lastLine, linedata, more);
        // Ensure the receivedBufferEvent callback finishes before we fire
        // the event notifying the doc provider of any changes
        (async () => {
            const uri = this.buildExternalBufferUri(await buffer.name, buffer.id);
            logger.debug(`received buffer event for ${uri}`);
            this.bufferProvider.documentDidChange.fire(uri);
            return uri;
        })().then(undefined, (e) => {
            logger.error(`failed to notify document change: ${e}`);
        });
    };

    /**
     * Set buffer options from vscode document
     * @param document
     */
    private async initBufferForDocument(document: TextDocument, buffer: Buffer, editor?: TextEditor): Promise<void> {
        const bufId = buffer.id;
        logger.debug(`Init buffer for ${bufId}, doc: ${document.uri.toString()}`);

        // !In vscode same document can have different insertSpaces/tabSize settings per editor
        // !however in neovim it's per buffer. We make assumption here that these settings are same for all editors
        // !It's possible to set expandtab/tabstop/shiftwidth when switching editors, but rare case
        const {
            options: { insertSpaces, tabSize },
        } = editor || { options: { insertSpaces: true, tabSize: 4 } };
        const eol = document.eol === EndOfLine.LF ? "\n" : "\r\n";
        const lines = document.getText().split(eol);

        if (editor) {
            this.editorTabConfiguration.set(editor, {
                tabSize: tabSize as number,
                insertSpaces: insertSpaces as boolean,
            });
        }

        const tabOptions: [string, unknown[]][] = [
            ["nvim_buf_set_option", [bufId, "expandtab", insertSpaces]],
            ["nvim_buf_set_option", [bufId, "tabstop", tabSize]],
            ["nvim_buf_set_option", [bufId, "shiftwidth", tabSize]],
        ];
        const number = !!(editor?.options.lineNumbers !== TextEditorLineNumbersStyle.Off);
        const relativeNumber = !!(editor?.options.lineNumbers === TextEditorLineNumbersStyle.Relative);
        const requests: [string, unknown[]][] = [
            // fill the buffer
            ["nvim_buf_set_lines", [bufId, 0, -1, false, lines]],
            // set vscode controlled flag so we can check it neovim
            ["nvim_buf_set_var", [bufId, "vscode_controlled", true]],
            // used for synchronization of number options
            ["nvim_buf_set_var", [bufId, "vscode_number", number]],
            ["nvim_buf_set_var", [bufId, "vscode_relativenumber", relativeNumber]],
            // buffer name = document URI
            ["nvim_buf_set_name", [bufId, BUFFER_NAME_PREFIX + document.uri.toString()]],
            // Turn off modifications for external documents
            ["nvim_buf_set_option", [bufId, "modifiable", !this.isExternalTextDocument(document)]],
            // force nofile, just in case if the buffer was created externally
            ["nvim_buf_set_option", [bufId, "buftype", "nofile"]],
            // list buffer
            ["nvim_buf_set_option", [bufId, "buflisted", true]],
            // nvim_buf_set_name will do filetype detection
            // we must override tab options after vim initializes defaults
            ...tabOptions,
        ];
        await callAtomic(this.client, requests, logger);
        // Debugging through breakpoints reveals that in some cases the indentation options are overridden again.
        // It is currently possible to work around this issue with a separate request
        await callAtomic(this.client, tabOptions, logger);
        // Looks like need to be in separate request
        if (!this.isExternalTextDocument(document)) {
            await this.client.callFunction("VSCodeClearUndo", bufId);
        }
        if (this.onBufferInit) {
            this.onBufferInit(bufId, document);
        }
        // start listen for buffer changes
        buffer.listen("lines", this.receivedBufferEvent);
    }

    private async resyncBufferTabOptions(editor: TextEditor, bufId: number): Promise<void> {
        const {
            options: { insertSpaces, tabSize },
        } = editor;

        const requests: [string, unknown[]][] = [
            ["nvim_buf_set_option", [bufId, "expandtab", insertSpaces]],
            ["nvim_buf_set_option", [bufId, "tabstop", tabSize]],
            ["nvim_buf_set_option", [bufId, "shiftwidth", tabSize]],
        ];
        await callAtomic(this.client, requests, logger);
    }

    /**
     * Create new neovim window
     */
    private async createNeovimWindow(bufId: number): Promise<number> {
        await this.client.setOption("eventignore", "BufWinEnter,BufEnter,BufLeave");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const win = await this.client.openWindow(bufId as any, false, {
            external: true,
            width: config.neovimViewportWidth,
            height: 100,
        });
        await this.client.setOption("eventignore", "");
        if (typeof win === "number") {
            throw new Error(`Unable to create a new neovim window, code: ${win}`);
        }
        return win.id;
    }

    private async unloadBuffer(bufId: number): Promise<void> {
        try {
            await this.client.command(`bunload! ${bufId}`);
        } catch (e) {
            logger.warn(`Can't unload the buffer: ${bufId}, err: ${(e as Error)?.message}`);
        }
    }

    private isVscodeUriName(name: string): boolean {
        if (/:\/\//.test(name)) {
            return true;
        }
        if (name.startsWith("output:") || name.startsWith(`${BUFFER_NAME_PREFIX}output:`)) {
            return true;
        }
        if (name.startsWith("/search-editor:") || name.startsWith(`${BUFFER_NAME_PREFIX}/search-editor:`)) {
            return true;
        }
        return false;
    }

    private findPathFromFileName(name: string): string {
        const folders = workspace.workspaceFolders;
        if (folders) {
            return path.resolve(folders[0].uri.fsPath, name);
        } else {
            return name;
        }
    }

    private findDocFromUri(uri: string): TextDocument | undefined {
        if (uri.startsWith("/search-editor")) {
            uri = uri.slice(1);
        }
        return workspace.textDocuments.find((d) => d.uri.toString() === uri);
    }

    private buildExternalBufferUri(name: string, id: number): Uri {
        // These might not *always* be file names, but they often are (e.g. for :help) so
        // make sure we properly convert slashes for the path component, especially on Windows
        return Uri.file(name).with({ scheme: BUFFER_SCHEME, authority: id.toString() });
    }

    private async attachNeovimExternalBuffer(
        name: string,
        id: number,
        expandTab: boolean,
        tabStop: number,
    ): Promise<void> {
        const uri = this.buildExternalBufferUri(name, id);
        logger.debug(`opening external buffer ${uri}`);

        let doc: TextDocument;
        try {
            doc = await workspace.openTextDocument(uri);
        } catch (error) {
            logger.debug(`unable to open external buffer: ${error}`);
            return;
        }

        this.externalTextDocuments.add(doc);
        this.textDocumentToBufferId.set(doc, id);
        this.onBufferInit && this.onBufferInit(id, doc);

        const windows = await this.client.windows;
        let closeWinId = 0;
        for (const window of windows) {
            const buf = await window.buffer;
            if (buf.id === id) {
                logger.debug(
                    `Found window assigned to external buffer ${id}, winId: ${
                        window.id
                    }, isKnownWindow: ${this.winIdToEditor.has(window.id)}`,
                );
                if (!this.winIdToEditor.has(window.id)) {
                    closeWinId = window.id;
                }
            }
        }

        const editor = await window.showTextDocument(doc, {
            preserveFocus: false,
            preview: true,
            viewColumn: ViewColumn.Active,
        });
        this.editorTabConfiguration.set(editor, { tabSize: tabStop, insertSpaces: expandTab });
        editor.options.insertSpaces = expandTab;
        editor.options.tabSize = tabStop;

        if (closeWinId) {
            // !Another hack is to retrieve cursor with delay - when we receive an external buffer the cursor pos is not immediately available
            // [1, 0]
            setTimeout(async () => {
                const neovimCursor: [number, number] = await this.client.request("nvim_win_get_cursor", [closeWinId]);
                if (neovimCursor) {
                    logger.debug(
                        `Adjusting cursor pos for external buffer: ${id}, originalPos: [${neovimCursor[0]}, ${neovimCursor[1]}]`,
                    );
                    const finalLine = neovimCursor[0] - 1;
                    let finalCol = neovimCursor[1];
                    try {
                        finalCol = convertByteNumToCharNum(doc.lineAt(finalLine).text, neovimCursor[1]);
                        logger.debug(`Adjusted cursor: [${finalLine}, ${finalCol}]`);
                    } catch (e) {
                        logger.warn(`Unable to get cursor pos for external buffer: ${id}`);
                    }

                    const selection = new Selection(finalLine, finalCol, finalLine, finalCol);
                    editor.selections = [selection];
                    editor.revealRange(selection, TextEditorRevealType.AtTop);
                }
            }, 1000);

            // ! must delay to get a time to switch buffer to other window, otherwise it will be closed
            // TODO: Hacky, but seems external buffers won't be much often used
            setTimeout(() => {
                logger.debug(`Closing window ${closeWinId} for external buffer: ${id}`);
                try {
                    this.client.request("nvim_win_close", [closeWinId, true]);
                } catch (e) {
                    logger.warn(
                        `Closing the window: ${closeWinId} for external buffer failed: ${(e as Error).message}`,
                    );
                }
            }, 5000);
        }
    }
}

/**
 * Implements the VSCode document provider API for external buffers from neovim.
 */
class BufferProvider implements TextDocumentContentProvider {
    /**
     * Fire this event to update the document contents (i.e. re-evaluate the provider).
     */
    public documentDidChange: EventEmitter<Uri> = new EventEmitter();

    onDidChange = this.documentDidChange.event;

    public constructor(
        private client: NeovimClient,
        private receivedBufferEvent: BufferManager["receivedBufferEvent"],
    ) {}

    async provideTextDocumentContent(uri: Uri, token: CancellationToken): Promise<string | undefined> {
        logger.debug(`trying to provide content for ${uri}`);

        const id = parseInt(uri.authority, 10);

        const buffers = await this.client.buffers;
        const buf = buffers.find((b) => b.id === id);
        if (!buf || token.isCancellationRequested) {
            logger.debug(`external buffer ${id} not found`);
            return;
        }

        // don't bother with displaying empty buffer
        const lines = await buf.lines;
        if (!lines.length || (lines.length === 1 && !lines[0])) {
            logger.debug(`Skipping empty external buffer ${id}`);
            return;
        }

        buf.listen("lines", this.receivedBufferEvent);
        await buf[ATTACH](true);

        return lines.join("\n");
    }
}
