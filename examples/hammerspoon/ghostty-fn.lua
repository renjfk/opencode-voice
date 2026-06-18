-- Optional example for OpenCode + opencode-voice in Ghostty.
--
-- Workflow:
-- - Press Fn to send leader+o and start recording.
-- - Hold Fn for at least LONG_PRESS_THRESHOLD_SECONDS and release to send
--   leader+r, which stops recording, normalizes, and submits the prompt.
--
-- Assumptions:
-- - OpenCode uses the default leader key, ctrl+x.
-- - Ghostty is the frontmost app.
-- - OpenCode is running in TARGET_TERMINAL.
-- - This is best used as a push-to-talk flow: hold Fn while speaking, then
--   release to submit.

local eventtap = hs.eventtap
local eventTypes = eventtap.event.types
local inspect = hs.inspect

local APP_NAME = "Ghostty"
local TARGET_TERMINAL = 1
local LONG_PRESS_THRESHOLD_SECONDS = 0.5
local START_RECORDING_ACTION = "\\x18o"
local SUBMIT_RECORDING_ACTION = "\\x18r"

local fnPressed = false
local fnPressedAt = 0
local fnPressStartedInTargetApp = false

local function notifyError(message)
  hs.notify.new({
    title = "Hammerspoon",
    informativeText = message,
  }):send()
end

local function isTargetAppActive()
  local window = hs.window.focusedWindow()
  if window ~= nil then
    local app = window:application()
    if app ~= nil and app:name() == APP_NAME then
      return true
    end
  end

  local app = hs.application.frontmostApplication()
  return app ~= nil and app:name() == APP_NAME
end

local function runGhosttyAction(action)
  local ok, result, err = hs.osascript.applescript(
    string.format(
      [[
tell application "%s"
  perform action "text:%s" on terminal %d
end tell
]],
      APP_NAME,
      action,
      TARGET_TERMINAL
    )
  )

  if ok then
    return
  end

  local errorValue = err or result
  local message

  if type(errorValue) == "table" then
    message = errorValue.NSAppleScriptErrorMessage
      or errorValue.NSLocalizedDescription
      or inspect(errorValue)
  else
    message = tostring(errorValue)
  end

  notifyError(APP_NAME .. " AppleScript failed: " .. message)
  print("[hammerspoon] " .. APP_NAME .. " AppleScript failed: " .. message)
end

eventtap.new({ eventTypes.flagsChanged }, function(event)
  local flags = event:getFlags()

  if flags.fn and not fnPressed then
    fnPressed = true
    fnPressedAt = hs.timer.secondsSinceEpoch()
    fnPressStartedInTargetApp = isTargetAppActive()
    if fnPressStartedInTargetApp then
      runGhosttyAction(START_RECORDING_ACTION)
    end
  elseif fnPressed and not flags.fn then
    fnPressed = false
    local heldFor = hs.timer.secondsSinceEpoch() - fnPressedAt
    if heldFor >= LONG_PRESS_THRESHOLD_SECONDS and fnPressStartedInTargetApp then
      runGhosttyAction(SUBMIT_RECORDING_ACTION)
    end
    fnPressStartedInTargetApp = false
  end

  return false
end):start()
