## Vendored Repositories

This project vendors external repositories under @repos/

- Use vendored repositories as read-only reference material when working with related libraries
- Prefer examples and patterns from the vendored source code over generated guesses or web search results
- Do not edit files under @repos/ unless explicitly asked
- Do not import from @repos/ - application code should continue importing from normal package dependencies

When writing Effect code, inspect @repos/effect/ for examples of idiomatic usage, tests, module structure, and API design. Treat it as the source of truth for Effect patterns.

Review the implementation, tests, and documentation for `Schema` in `@repos/effect`.

Create a file at `agent-patterns/effect-schema.md` that illustrates the most important patterns an agent should follow when writing Schema code in this project.

Include:

- Common constructors and combinators
- Encoding and decoding examples
- Transformation patterns
- Error handling patterns
- Examples copied or adapted from the Effect codebase
- Notes about what to avoid

## Stock and securities research

- Prefer TIKR for stocks and securities research.
- The user maintains `TIKR_UN` and `TIKR_PW` in the local `.env`. Never print their values, include them in prompts or tool results, or commit them.
- These are account credentials, not API credentials. Victral's optional browser research tools use them locally; see [TIKR setup and limitations](docs/TIKR.md). TIKR currently [does not offer an API and warns against automated access](https://support.tikr.com/hc/en-us/articles/38745028283931-Does-TIKR-offer-an-API). Do not promise real-time or complete coverage; use the returned page's dates, units and currency.
- Clearly identify the source and date of financial data, and say when TIKR data is unavailable rather than silently substituting another source.
