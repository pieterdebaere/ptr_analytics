/**
 * Compiles a path glob into a predicate matching a whole pathname.
 * `*` matches any characters within one path segment, `**` matches anything
 * (including `/`). A trailing `/**` also matches the bare prefix, so `/admin/**`
 * matches `/admin`, `/admin/` and `/admin/users/1`. Runs of 3+ `*` act like `**`.
 *
 * Matching simulates the glob as an NFA (one pass over the path, no backtracking),
 * so it takes O(path length × glob length) time for any input.
 */
export function globMatcher(glob: string): (path: string) => boolean {
  // Tokens: '**' (anything), '*' (anything but '/'), or a single literal character.
  const t = glob.trim().match(/\*\*+|[^]/g) || [];
  const n = t.length;
  const run = (m: number, s: string) => {
    // st[i]: the first i tokens match the path read so far.
    let st: boolean[] = [];
    const add = (a: boolean[], i: number) => {
      // A star may match nothing, so reaching it also reaches the token after it.
      for (; !a[i]; i++) if (((a[i] = true), i >= m || t[i]![0] != '*')) break;
    };
    add(st, 0);
    for (let j = 0; j < s.length; j++) {
      const c = s[j]!;
      const nx: boolean[] = [];
      for (let i = 0; i < m; i++)
        if (st[i]) {
          const k = t[i]!;
          if (k[1] || (k == '*' && c != '/')) add(nx, i);
          else if (k == c) add(nx, i + 1);
        }
      st = nx;
    }
    return !!st[m];
  };
  // Trailing '/**': also match the prefix alone.
  const bare = n > 1 && t[n - 1]![1] && t[n - 2] == '/';
  return (s) => run(n, s) || (!!bare && run(n - 2, s));
}
