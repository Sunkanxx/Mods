// Pure path helpers; the separator follows the base it is given.

export function joinPath(base, ...parts) {
  const sep = base.includes("\\") ? "\\" : "/";
  let out = base;
  for (const part of parts) {
    out = out.replace(/[\\/]+$/, "") + sep + part;
  }
  return out;
}

// The directory itself, then each parent up to the root ("C:\" or "/"), nearest first.
export function selfAndParents(dir) {
  const out = [];
  let p = dir.replace(/[\\/]+$/, "");
  if (p === "" || /^[A-Za-z]:$/.test(p)) p = dir.slice(0, p.length + 1);
  for (;;) {
    out.push(p);
    const cut = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    if (cut < 0) break;
    let parent = p.slice(0, cut);
    if (parent === "" || /^[A-Za-z]:$/.test(parent)) parent = p.slice(0, cut + 1);
    if (parent === p) break;
    p = parent;
  }
  return out;
}

export function configDirFrom(env) {
  if (env.CLAUDE_CONFIG_DIR) return env.CLAUDE_CONFIG_DIR;
  if (env.USERPROFILE) return joinPath(env.USERPROFILE, ".claude");
  if (env.HOME) return joinPath(env.HOME, ".claude");
  return null;
}

export function scopeFiles(base) {
  return {
    lessons: joinPath(base, "lessons-learned.md"),
    rules: joinPath(base, "rules-learned.md"),
  };
}
