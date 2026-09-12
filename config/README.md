# Model configuration

`models.json` maps each ROLE to a provider and model. Nothing in `src/` hardcodes a model
id: free tiers and model names both move faster than code does.

## Filling it in

Model ids read `REPLACE_ME` on purpose. Before first use, pull the provider's live model
list and paste in what is actually available to you today:

- Gemini — https://ai.google.dev/gemini-api/docs/models
- OpenRouter — `curl https://openrouter.ai/api/v1/models | jq '.data[].id'`

## Keys

Set whichever you have. A provider with no key is simply not registered, and the router
falls through to the next one in `fallback_chain`.

```
GEMINI_API_KEY=...
OPENROUTER_API_KEY=...
```

With no keys at all, the CLI uses `MockLLM` — deterministic, offline, free. The whole test
suite runs that way.

## Roles

| role | what it does | wants |
|---|---|---|
| `intent` | free text → structured action | cheap, fast, temperature 0 |
| `narrate` | the DM's prose | the good model |
| `narrate_hi` | scene openings and big beats | better, used sparingly |
| `companion` | a party member's line | cheap |
| `digest` | compress a finished scene, tone only | cheap |
| `ambient` | how an offscreen event looked | cheap |
