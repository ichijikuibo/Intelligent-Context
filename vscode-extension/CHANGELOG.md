# Changelog

## 0.1.0

Initial release.

- Registers an Intelligent Context language model chat provider with VS Code so
  the chat model picker is populated from the proxy's `/v1/models` endpoint.
- Auto-discovers models, including per-model context-window sizes and the wire
  protocol (OpenAI chat completions or Anthropic messages) each model expects.
- Sends `X-Project-Root`, `X-IC-Project-Name`, `X-IC-File`, `X-IC-Branch`, and
  `X-Session-Id` headers for automatic project attribution.
- Stores the proxy API key in VS Code's encrypted secret storage.
- Supports duplicate model IDs across providers via provider-scoped prefixes
  (for example `OCO-deepseek-v4` and `DSK-deepseek-v4`).
- Streams both OpenAI-format and Anthropic-format responses.
