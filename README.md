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

**Bug Reports**

Simply log an issue with clear steps to reproduce the bug.

Be sure to include details on what the expected results were.

Contributions are also welcome as long as they are under the MIT License.

## Features

The goal for Delver Chat is to be a useful research assistant without any unnecessary tools.

Some highlights here are:

- Export and Import chat histories.
- Fork a chat from anywhere in the history.
- Tools for the AI to search and read notes.
- Ability to edit practically any part of the chat.

The majority of the tooling you see in Devler Chat is what I think should be the industry standard for any AI chat tool.

## Model Recommendations

**Ministral 3**

Ollama Model Page: https://ollama.com/library/ministral-3

As of writing this these models are very small and performant.
In limited testing with the default system prompt of Delver, they seem capable of being able to find and walk the user through notes with runbooks.
These models have a 256k context window.

- `ollama pull ministral-3:3b`
- `ollama pull ministral-3:8b`
- `ollama pull ministral-3:14b`

**GPT OSS**

Ollama Model Page: https://ollama.com/library/gpt-oss

This is the open source model from OpenAI.
It is small enough that many high end gaming PCs can run it and it is somewhat competent with tool calling.
This model has a 128k context window.

- `ollama pull gpt-oss:20b`

**GPT OSS Safeguard**

Ollama Model Page: https://ollama.com/library/gpt-oss-safeguard

A newer refreshed `gpt-oss` essentially.
Performs similarly overall.
This model has a 128k context window.

- `ollama pull gpt-oss-safeguard:20b`

**Qwen3**

Ollama Model Page: https://ollama.com/library/qwen3

Only going to list one of the models here for Qwen 3.
It can be slowed down by it's verbose thinking process.
However the 4b version stands out due to it's large 256k context window.

- `ollama pull qwen3:4b`
