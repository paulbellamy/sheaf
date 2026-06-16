/**
 * Tiny glob → RegExp compiler shared by the backend's `glob()` and the style
 * corpus selector. Supports `**` (any depth, optionally `/`-anchored), `*`
 * (within a path segment), and `?`. Anchored at both ends.
 */
export function globToRegex(glob: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 3;
      } else {
        re += ".*";
        i += 2;
      }
    } else if (c === "*") {
      re += "[^/]*";
      i += 1;
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (".+^$()|[]{}\\".includes(c)) {
      re += `\\${c}`;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  re += "$";
  return new RegExp(re);
}
