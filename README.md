# Cadence
Pacing stand-up meeting made easy!

## Demo

[![Open Cadence](https://img.shields.io/badge/Open-Cadence-blue)](https://leocencetti.github.io/Cadence/)

Click the button above to use the app now, or visit [cadence.leocencetti.com](https://cadence.leocencetti.com) once the custom domain is wired up.

## What it does

Cadence is a static, single-page timer for pacing group standup meetings:

1. **Setup** — configure the total meeting time budget and add roles (name, time allowance per person, headcount).
2. **Run** — tap a role's card to start that person's turn; the card fills up as their time runs out and alarms (sound + vibration) once they go over.
3. **Pace** — a pace bar and a soft background tint show whether the meeting overall is running ahead of or behind its budget, independent of how any single turn is going.

State is kept in `localStorage`, so a refresh mid-meeting resumes exactly where it left off.

## Structure

```
app/
  index.html   # setup screen + active screen
  styles.css   # theme tokens (light/dark), layout, card + animation styles
  app.js       # state management, localStorage, timer/pace logic
  audio.js     # alarm tone (synthesized via Web Audio, no bundled asset needed)
  CNAME        # custom domain for GitHub Pages
```

No build step, no framework, no backend — open `app/index.html` directly or serve the `app/` folder from any static host.

## Deployment

Pushes to `main` are deployed to GitHub Pages automatically via `.github/workflows/gh-pages.yml` (see Actions tab / repo Settings → Pages).
