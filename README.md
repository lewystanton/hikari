# Hikari ✦ — personal anime library

A light-mode Electron app for tracking the anime you watch.

- **Search & add** — `Ctrl+K` opens a command-palette search over the AniList database; click a result to add it to your shelf.
- **Rich details** — cover art, banner, story, genres, score, studio, airing countdown, seasons & related shows, episode list with preview thumbnails (AniList streaming episodes, falling back to MyAnimeList/Jikan), and audio languages derived from voice-cast data (so you can see if an English dub exists).
- **Sources** — attach where *you* watch each show (Netflix, Crunchyroll, Disney+, …) with a clickable URL. Official streaming links from AniList can be adopted with one click.
- **Pretty** — custom WebGL "pastel silk" aurora shader background, 3D-tilt cards with glare, view transitions, Fraunces + Outfit typography.

## Run

```
npm install
npm start
```

Data is stored in `library.json` under the Electron `userData` folder — no account, no cloud.

APIs used: [AniList GraphQL](https://docs.anilist.co) and [Jikan](https://jikan.moe) (both free, no keys).
