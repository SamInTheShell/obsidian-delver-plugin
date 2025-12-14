# Delver

A local AI research assistant for your notes.

**Status**

If this plugin gains any traction, I'll submit it to be listed.
For now installation is just manual and the only LLM provider available is Ollama.
The plugin is completely local, open source, and does not have any write tools for the LLM.

**Installing Delver**

1. In your Obsidian Vault directory, do the following.

```shell
mkdir -p .obsidian/plugins/obsidian-delver
cd .obsidian/plugins/obsidian-delver
curl -sLO https://github.com/SamInTheShell/obsidian-delver-plugin/releases/download/1.0.0/main.js
curl -sLO https://github.com/SamInTheShell/obsidian-delver-plugin/releases/download/1.0.0/manifest.json
curl -sLO https://github.com/SamInTheShell/obsidian-delver-plugin/releases/download/1.0.0/styles.css
```

2. In the Obsidian settings, go to "Community Plugins" on the left.
3. Ensure community plugins are enabled.
4. Refresh the plugin list.
5. Enable `Delver Plugin`.
6. Close the settings.
7. Open a new chat from the ribbon or with CTRL+SHIFT+C.
