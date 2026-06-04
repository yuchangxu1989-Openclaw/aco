# ACO Hello Plugin

A minimal ACO plugin example that demonstrates the plugin system.

## What It Does

Hooks into the `before_prompt_build` event and prints a greeting to the ACO log. It is the "Hello, World!" of ACO plugins — a complete, loadable plugin in ~20 lines of code.

## How to Install

Place the `hello-plugin/` folder (or a symlink to it) inside your ACO `extensions/` directory:

```bash
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
mkdir -p "$OPENCLAW_HOME/extensions"
ln -s "$PWD" "$OPENCLAW_HOME/extensions/hello-plugin"
```

Then add the plugin to your `openclaw.json` under `plugins.entries`:

```json
"aco-hello-plugin": {
  "package": "./extensions/hello-plugin"
}
```

Restart the Gateway for the plugin to take effect.

## How to Run / Verify

```bash
# Load the plugin module to confirm it parses correctly
node -e "import('./index.js').then(m => console.log('OK:', m.default.id))"

# Expected output:
# OK: aco-hello-plugin
```

Once installed and the Gateway is running, watch the log for:

```
[HelloPlugin] plugin registered successfully
[HelloPlugin] hello from ACO plugin!
```
