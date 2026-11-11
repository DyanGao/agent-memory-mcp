# The README demo, recorded with vhs (https://github.com/charmbracelet/vhs):
#   MEMORY_URL=http://127.0.0.1:8787 MEMORY_API_KEY=... vhs docs/demo/demo.tape
# Needs a running agent-memory-mcp server and worker, and Claude Code signed in.
# Everything shown is a real run in real time: the decision is captured by the
# SessionEnd hook, distilled by the local model, and injected by SessionStart.

Output docs/demo/demo.gif

Set Shell "bash"
Set FontSize 15
Set Width 1180
Set Height 720
Set Padding 20
Set TypingSpeed 35ms
Set Theme "Catppuccin Mocha"

Hide
Type `export PS1='$ ' REPO="$PWD" DEMO="$(mktemp -d)/invoices"` Enter
Type `"$REPO/docs/demo/setup.sh" "$DEMO" >/dev/null && cd "$DEMO" && source .demo-env` Enter
# What a normal install picks up from project settings, plus edits allowed and
# only the tools this task needs, so the recording shows nothing unrelated.
Type `alias claude='claude --model haiku --setting-sources project,local --mcp-config .mcp.json --strict-mcp-config --permission-mode acceptEdits --tools Read,Write,Edit,Glob'` Enter
Type `export PATH="$REPO/docs/demo:$PATH"; clear` Enter
Sleep 1s
Show

Type "# Monday: a decision, made in conversation" Enter
Sleep 500ms
Type `claude -p "Decision for this project: our fiscal year starts on April 1, and invoice numbers restart then, formatted like FY26-0001, where FY26 runs from April 2026 to March 2027. Reply in one line."` Enter
Wait@180s /^\$$/
Sleep 3s

Type "# The session ended. The hook captured it, and the local model distilled it:" Enter
Hide
Type `until [ -n "$(mem list)" ]; do sleep 3; done; sleep 10; clear` Enter
Wait@180s /^\$$/
Show
Type "mem list" Enter
Wait /^\$$/
Sleep 2s

Type "# Tuesday: a brand-new session gets a task that needs that decision" Enter
Sleep 500ms
Type `claude -p "Create invoice.mjs with nextInvoiceNumber(last, today). Don't run anything or print file paths. Then, in two short lines: the numbering rule you used, and where it came from."` Enter
Wait@240s /^\$$/
Sleep 3s

Type "# Right to be forgotten: preview, delete, receipt" Enter
Type `mem forget "invoice numbering"` Enter
Wait /^\$$/
Type "mem list   # nothing left" Enter
Wait /^\$$/
Sleep 4s
