const { readdirSync, statSync } = require('fs');
const { join } = require('path');

function findDirs(name, root, maxDepth = 5) {
  const results = [];
  const queue = [{ path: root, depth: 0 }];
  while (queue.length) {
    const { path, depth } = queue.shift();
    if (depth > maxDepth) continue;
    try {
      const entries = readdirSync(path);
      for (const entry of entries) {
        const full = join(path, entry);
        const s = statSync(full);
        if (s.isDirectory()) {
          if (entry === name) results.push(full);
          queue.push({ path: full, depth: depth + 1 });
        }
            }
    } catch (_) {}
  }
  return results;
}

const beastDirs = findDirs('beast', '/Users', 6);
console.log('Found beast directories:', beastDirs);

const btsxFiles = [];
beastDirs.forEach(dir => {
  const findBtsx = (path, depth) => {
    if (depth > 5) return;
    try {
      const entries = readdirSync(path);
      for (const entry of entries) {
        const full = join(path, entry);
        const s = statSync(full);
        if (s.isDirectory()) {
          findBtsx(full, depth + 1);
        } else if (entry.endsWith('.btsx')) {
          btsxFiles.push(full);
        }
      }
    } catch (_) {}
  };
  findBtsx(dir, 0);
});
console.log('Found .btsx files:', btsxFiles.slice(0, 20));