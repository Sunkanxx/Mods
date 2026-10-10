// last-call's handoff note: where it may live, whether a tool call targets it,
// and its line in the repository's local exclude file.
// Pure functions of plain values; nothing here takes $.

// A path with forward slashes, no empty or "." segments, ".." folded in.
// Returns null when ".." climbs above the start.
export function normalize(path) {
  const isAbs = path.startsWith("/") || /^[A-Za-z]:/.test(path);
  const parts = [];
  for (const seg of path.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0 || (parts.length === 1 && /^[A-Za-z]:$/.test(parts[0]))) return null;
      parts.pop();
    } else parts.push(seg);
  }
  const joined = parts.join("/");
  return isAbs && !/^[A-Za-z]:/.test(joined) ? `/${joined}` : joined;
}

const sameCase = (p) => (/^[A-Za-z]:/.test(p) ? p.toLowerCase() : p);

// Whether path lies strictly inside root (both normalized, absolute).
export function isInside(root, path) {
  const r = sameCase(root).replace(/\/$/, "");
  return sameCase(path).startsWith(`${r}/`);
}

// The note's absolute path from the setting, or null when it would leave root.
export function targetFrom(root, setting) {
  // The path is quoted to the model: no control characters to smuggle lines in.
  if (/[\u0000-\u001f\u007f]/.test(setting)) return null;
  const isAbs = setting.startsWith("/") || /^[A-Za-z]:[\\/]/.test(setting);
  const path = normalize(isAbs ? setting : `${root}/${setting}`);
  const base = normalize(root);
  return path && base && isInside(base, path) ? path : null;
}

// Whether a tool call's file_path is exactly the note.
export function isTarget(target, filePath) {
  if (!target || typeof filePath !== "string") return false;
  const p = normalize(filePath);
  return p !== null && sameCase(p) === sameCase(target);
}

// The parents of a path, nearest first: where an existence check starts.
export function parentsOf(path) {
  const out = [];
  let p = path;
  while (p.includes("/") && p.lastIndexOf("/") > 0) {
    p = p.slice(0, p.lastIndexOf("/"));
    out.push(p);
  }
  return out;
}

// The exclude-file line for the note, relative to the repository's top level:
// anchored with "/", glob characters escaped. null for a path outside the
// repository or one a line cannot hold.
export function excludeLine(topLevel, target) {
  const top = normalize(topLevel);
  if (!top || !isInside(top, target) || /[\r\n]/.test(target)) return null;
  const rel = target.slice(top.replace(/\/$/, "").length + 1);
  return `/${rel.replace(/[\\*?[\]!#]/g, (c) => `\\${c}`)}`;
}

export function hasLine(text, line) {
  return text.split(/\r?\n/).some((l) => l.trim() === line);
}
