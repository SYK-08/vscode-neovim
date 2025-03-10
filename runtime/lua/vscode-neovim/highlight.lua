---@diagnostic disable: inject-field

-- Copy global highlights and overrides highlights to the custom namespace, only external buffers use global namespace
local api = vim.api

local NS = api.nvim_create_namespace("-- vscode buffer highlights --")

vim.opt.conceallevel = 0
vim.g.html_ignore_conceal = 1
vim.g.vim_json_conceal = 0

---Link highlights with same values to the same highlight, to avoid performance
---and rendering issues with vscode decorations caused by a large number of
---highlight IDs due to highlight merging.
---Currently, only handle highlights that need to be cleared
api.nvim_set_hl(0, "VSCodeNone", {})

---@param id number
---@param name string
---@param value table
local function set_hl(id, name, value)
  if vim.tbl_isempty(value) then
    return api.nvim_set_hl(id, name, { link = "VSCodeNone" })
  end
  return api.nvim_set_hl(id, name, value)
end

local function setup_globals()
  set_hl(0, "Normal", {})
  set_hl(0, "NormalNC", {})
  set_hl(0, "NormalFloat", {})
  set_hl(0, "NonText", {})
  set_hl(0, "Visual", {})
  set_hl(0, "VisualNOS", {})
  set_hl(0, "Substitute", {})
  set_hl(0, "Whitespace", {})
  set_hl(0, "LineNr", {})
  set_hl(0, "LineNrAbove", {})
  set_hl(0, "LineNrBelow", {})
  set_hl(0, "CursorLine", {})
  set_hl(0, "CursorLineNr", {})
  -- make cursor visible for plugins that use fake cursor
  set_hl(0, "Cursor", { reverse = true })
end

-- stylua: ignore start
local overrides = {
    NonText     = {}, EndOfBuffer  = {}, ErrorMsg       = {}, MoreMsg      = {}, ModeMsg     = {},
    Question    = {}, VisualNC     = {}, WarningMsg     = {}, Sign         = {}, SignColumn  = {},
    ColorColumn = {}, QuickFixLine = {}, MsgSeparator   = {}, MsgArea      = {}, Operator    = {},
    Delimiter   = {}, Identifier   = {}, SpecialChar    = {}, Number       = {}, Type        = {},
    String      = {}, Error        = {}, Comment        = {}, Constant     = {}, Special     = {},
    Statement   = {}, PreProc      = {}, Underlined     = {}, Ignore       = {}, Todo        = {},
    Character   = {}, Boolean      = {}, Float          = {}, Function     = {}, Conditional = {},
    Repeat      = {}, Label        = {}, Keyword        = {}, Exception    = {}, Include     = {},
    Define      = {}, Macro        = {}, PreCondit      = {}, StorageClass = {}, Structure   = {},
    Typedef     = {}, Tag          = {}, SpecialComment = {}, Debug        = {}, Folded      = {},
    FoldColumn  = {},
}
-- stylua: ignore end
local overridden = {}
local function setup_overrides()
  for name, attrs in pairs(overrides) do
    if not overridden[name] then
      overridden[name] = true
      set_hl(NS, name, attrs)
    end
  end
end

local cleared_syntax_groups = {}
local function setup_syntax_groups()
  local output = api.nvim_exec2("syntax", { output = true })
  local items = vim.split(output.output, "\n")
  for _, item in ipairs(items) do
    local group = item:match([[([%w@%.]+)%s+xxx]])
    if group and not cleared_syntax_groups[group] then
      cleared_syntax_groups[group] = true
      set_hl(NS, group, {})
    end
  end
end

local function set_win_hl_ns()
  local ok, curr_ns, target_ns, vscode_controlled
  for _, win in ipairs(api.nvim_list_wins()) do
    local buf = api.nvim_win_get_buf(win)

    ok, curr_ns = pcall(api.nvim_win_get_var, win, "_vscode_hl_ns")
    curr_ns = ok and curr_ns or 0

    ok, vscode_controlled = pcall(api.nvim_buf_get_var, buf, "vscode_controlled")
    target_ns = (ok and vscode_controlled) and NS or 0

    if curr_ns ~= target_ns then
      api.nvim_win_set_var(win, "_vscode_hl_ns", target_ns)
      api.nvim_win_set_hl_ns(win, target_ns)
    end
  end
end

-- {{{ autocmds
local group = api.nvim_create_augroup("VSCodeNeovimHighlight", { clear = true })
api.nvim_create_autocmd({ "BufWinEnter", "BufEnter", "WinEnter", "WinNew", "WinScrolled" }, {
  group = group,
  callback = set_win_hl_ns,
})
api.nvim_create_autocmd({ "VimEnter", "ColorScheme", "Syntax", "FileType" }, {
  group = group,
  callback = function()
    api.nvim_set_hl(0, "VSCodeNone", {})
    setup_globals()
    -- highlights of custom namespace
    setup_overrides()
    vim.defer_fn(setup_syntax_groups, 200) -- wait syntax things done
  end,
})
-- }}}

setup_globals()
setup_overrides()
setup_syntax_groups()
