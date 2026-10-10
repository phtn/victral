export function citationFooter(blocks) {
  const sources = new Map();
  for (const block of blocks) for (const citation of [...(block.annotations ?? []), ...(block.citations ?? [])]) {
    const url = citation.url ?? citation.url_citation?.url;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
    const title = citation.title ?? citation.url_citation?.title ?? url;
    sources.set(url, String(title).replace(/[\[\]\r\n]/g, ' '));
  }
  return sources.size ? '\n\nSources:\n' + [...sources].map(([url, title]) => `- [${title}](<${url.replace(/[<>\r\n]/g, '')}>)`).join('\n') : '';
}
