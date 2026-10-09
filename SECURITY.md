# Security

If you find a security problem on afrazali.vercel.app or in this repository, please report it privately through GitHub's **Report a vulnerability** button (Security tab), not in a public issue.

What the site does:
- It is a static page plus one small function, `api/clip`, which redirects the video player to Instagram's CDN. It only does so for posts listed in `api/_clips.json`.
- There are no accounts, cookies or forms that send data anywhere. The brief builder only copies text to the visitor's clipboard and opens Instagram.
- Headers in `vercel.json`: a strict Content-Security-Policy, HSTS, `X-Frame-Options: DENY`, `nosniff`, COOP/CORP and a restrictive Permissions-Policy.
- The sync treats everything from Instagram as untrusted input (strict patterns, CDN-only media, size limits, escaped output).
