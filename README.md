# Token Usage Tracker

A SillyTavern extension that tracks and visualizes token usage for your chats.

## Installation

1.  Open SillyTavern and navigate to the **Extensions** menu (blocks icon).
2.  Click on **Install Extension**.
3.  Paste the repository URL into the "Extension URL" field:
    ```
    https://github.com/eteitaxiv/Extension-TokenUsage
    ```
4.  Click **Install for all users** or **Install just for me**.

## Usage

The extensions panel keeps a compact drawer with per-model token counts
(input / output / requests). The full usage chart and the
today/week/month/all-time stats open as a popup from the **Extensions wand
menu** (magic wand icon → "Token Usage") or via the **Stats** button in the
extension drawer.

## Features

 - Token tracking only — no pricing, no costs. Prices vary per provider and
   are meaningless for subscription or local/open-source model usage.
 - API-reported usage capture: SillyTavern discards the `usage` objects that
   providers attach to generation responses, so this extension captures them
   itself and records exact input/output token counts when available
   (OpenAI-compatible, Anthropic, and Gemini shapes, incl. proxies like
   LiteLLM and OpenRouter).
 - Fallback to SillyTavern's native tokenizer (async, respects your tokenizer
   settings) when the provider reports no usage.
 - Per day, week, month, and all time tokens in, tokens out, and request count.
 - Tracks quiet and background requests.
 - CSV export of the full usage history (one row per day x model).

## License

This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). See the `LICENSE` file for details.
