# Afraz Ali — portfolio

The portfolio of **Afraz Ali** ([@afrxz.fx](https://www.instagram.com/afrxz.fx/)), a freelance video editor. It builds itself from his public Instagram, and new posts show up on their own.

Live: https://afrazali.vercel.app

## How it stays up to date

```
Instagram ──(every 3 h, GitHub Actions)──► scripts/sync-instagram.mjs ──► data/instagram.json + assets/ig/
                                                                            │
                                                     scripts/build.mjs ◄────┘
                                                            │
                                         index.html, api/_clips.json ──(push)──► Vercel
```

- **Sync** (`scripts/sync-instagram.mjs`) reads the profile while logged out.
  - From a home connection it reads the profile page: bio, highlights and the whole grid **in Afraz's own order**.
  - GitHub's servers get Instagram's login wall, so the sync falls back to the public embeds there. These list the newest posts and carry the video files.
  - For each new post it saves a poster, a thumbnail and a 6-second muted preview loop, made with ffmpeg. For the showreel it also saves a longer hero loop.
  - Posts deleted on Instagram disappear from the site after two checks at least 6 hours apart.
- **Build** (`scripts/build.mjs`, with the caption logic in `scripts/derive.mjs`) renders the page.
  - **Titles** come from the captions: emoji and hashtag clutter are removed, and @handles are swapped for real names (looked up once and cached).
  - Each post is sorted into one of three kinds: **showreel**, **client work** or **edit**.
  - **No repeats:** every post appears exactly once on the page. A cut posted twice (same poster and length) is shown once. Two cuts with the same title become "… · Take 2".
- **Player:** clicking a cut opens a built-in player with sound and J/K/L shuttle keys. `api/clip.js` sends the player to a fresh copy of the video on Instagram's CDN. Instagram signs those links for about a day, and the redirect is cached for 4 hours.
  - Posts with licensed music can only play on Instagram. For those, the player shows the preview loop and a "Watch on Instagram" button.

## Hand edits

Edit `data/curation.json` on GitHub and the page re-renders by itself.

| key | what it does |
| --- | --- |
| `posts.<code>.title` | replace an automatic title (the code is the part after `/p/` in the post's link) |
| `posts.<code>.kind` | `reel`, `client` or `edit` |
| `posts.<code>.blurb` | replace the description shown in the player |
| `posts.<code>.show` | `true` keeps a post the duplicate check hid |
| `hide` | post codes to leave off the site |
| `clients` | extra @handles for the "Edited for" credits (the bio's `Clients :` line is read automatically) |
| `tagline`, `about` | the line under his name, and the About paragraphs |

To review every automatic title, run `node scripts/derive.mjs`.

## Run it locally

```sh
npm ci --prefix scripts
node scripts/sync-instagram.mjs     # needs ffmpeg (brew install ffmpeg) or FFMPEG=/path/to/ffmpeg
node scripts/build.mjs
npx serve .                          # the player's /api/clip needs `npx vercel dev`
```

From the Actions tab you can also run the workflow by hand:
- **refresh_all** re-reads every post.
- **probe** checks whether particular posts are still public.

## Security

`vercel.json` sets a strict Content-Security-Policy (no inline scripts; media only from this site and Instagram's CDN), HSTS, frame and referrer policies.

Everything read from Instagram is treated as untrusted:
- post codes and handles are checked against strict patterns;
- media is downloaded only from Instagram's CDN, with size limits;
- all text is escaped when the page is rendered.

`api/clip` only serves posts that are on the page, and only redirects to Instagram's video hosts. The workflow pins its actions to commit SHAs and runs with read-only permissions apart from pushing to `main`.
