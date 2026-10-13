/**
 * Converts a path glob to a RegExp matching a whole pathname.
 * `*` matches any characters within one path segment, `**` matches anything
 * (including `/`). A trailing `/**` also matches the bare prefix, so `/admin/**`
 * matches `/admin`, `/admin/` and `/admin/users/1`.
 */
export function globToRegExp(glob: string): RegExp {
  return new RegExp(
    '^' +
      glob
        .trim()
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\/\*\*$/, '\x01')
        .replace(/\*\*/g, '\x02')
        .replace(/\*/g, '[^/]*')
        .replace(/\x02/g, '.*')
        .replace('\x01', '(?:/.*)?') +
      '$',
  );
}
