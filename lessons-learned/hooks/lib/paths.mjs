// Pure path helpers; the separator follows the base it is given.

export function joinPath(base, ...parts) {
  const sep = base.includes("\\") ? "\\" : "/";
  let out = base;
  for (const part of parts) {
    out = out.replace(/[\\/]+$/, "") + sep + part;
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
