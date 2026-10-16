# TIKR research

Victral exposes `tikr_search`, `tikr_open`, `tikr_read_page` and
`tikr_find_in_page` when `TIKR_UN` or `TIKR_PW` is configured. Both values are
required to sign in. Bun loads the local `.env` when launching Victral; the
credentials must be available in the launching process, even when `--project`
selects another directory. Restart Victral after changing them.

Install Google Chrome locally and the normal locked project dependencies with
`bun install`. The browser library uses Chrome's installed channel; it does not
download a browser, use your normal Chrome profile, or require `--allow-shell`.
Opening Victral or listing tools does not launch Chrome or contact TIKR. The
first search or company-page request starts a separate headless browser and
signs in using the configured account. The session is reused until shutdown,
cancellation or an error, then closed. Authentication state is not exported.

TIKR [states that it offers no API and that programmatic access or scraping can
permanently close an account](https://support.tikr.com/hc/en-us/articles/38745028283931-Does-TIKR-offer-an-API).
This is browser automation of the website, not an official integration or an
approved API. Using these tools carries that account risk. No authenticated
request is made merely by installing or starting Victral. Automated tests use
fake browser sessions and do not establish that your account can access TIKR.

## Research workflow

1. Ask Victral about a stock or security. Its runtime context prefers TIKR
   when the research tools are configured, independent of the selected project.
2. `tikr_search({"query":"AAPL"})` returns up to 20 company or ETF labels with
   session-local `result_id` values. Check the company, ticker and exchange.
   The current search supports the listings shown by TIKR's main search results;
   secondary-listing expansion is not implemented. Search results contain no
   prices or financial statements.
3. `tikr_open({"result_id":"tikr-result-1-1","section":"financials"})` selects
   that exact row and opens the company's financials. Sections are `overview`,
   `financials` and `transcripts`. The tool captures the rendered page, including
   tables as displayed. It does not click transcript entries, change financial
   filters, build valuations or modify watchlists/portfolios.
4. Use `tikr_read_page` and `tikr_find_in_page` to inspect the retained snapshot
   without another request. To change sections, pass the returned company URL
   to `tikr_open` with the desired section. Result IDs expire on a new search or
   page navigation. Snapshot IDs belong to this running session; the latest 16
   snapshots are retained, with a 2 MB text limit on each.

Every company snapshot identifies TIKR, its company URL and `retrieved_at`.
Retrieval time is not a price timestamp. Check the displayed data date, financial
period, currency and units; prices may be delayed and content depends on your
subscription. The agent should identify coverage/access failures before using
another source. Citations link to TIKR company pages and may require sign-in.

Credentials stay outside model arguments and prompts. Known credential values
are redacted from snapshot/search text, browser launch receives only OS settings,
and ordinary agent command subprocesses exclude `TIKR_UN` and `TIKR_PW`.
The tools do not save screenshots, traces, cookies or passwords. Like other
project secrets, `.env` remains readable by an explicitly authorized file read;
command execution is not a host filesystem sandbox.

Requests are serialized and have a 90-second overall deadline. Cancellation
closes the research browser and drains outstanding work. Failed sign-ins are
not retried within a call; verification challenges, password changes and billing
remain user actions. Authentication errors and changed selectors fail visibly
with safe diagnostics. Research workers and `parallel_tools` do not receive
these account-backed tools.

The login fields and search selectors were checked against TIKR's public login
interface and shipped search components. An authenticated live research run
was not performed during implementation. TIKR can change its UI; offline tests
verify the tool boundary and lifetime behavior, not future website compatibility.
