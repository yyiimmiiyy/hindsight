# Hindsight

A pull request reviewer for Windows, powered by Claude, that learns from your team's past mistakes.

Most review tools start from zero on every pull request. Hindsight keeps a list of **lessons** for each repository: short rules drawn from bugs that reached your code. Every review checks the change against those lessons, so a mistake you have already paid for is caught the next time someone is about to repeat it.

Hindsight is free and open source, from [Goodhope Technologies](https://goodhopetechnologies.com).

## What it does

- **Reviews pull requests.** Pick a GitHub repository and a pull request. Claude reads the changes and reports concrete defects, each with the file, the line and a suggested fix.
- **Learns from mistakes.** When a bug slips through, describe what happened or point to the pull request involved. Claude works out the immediate cause and the root cause and proposes a prevention rule. You edit it, then save it.
- **Applies what it learned.** Saved lessons go into every later review of that repository. Findings that break a lesson are labelled with it.
- **Posts only when you say so.** You read the review first. Posting adds it to the pull request as a comment from your account; Hindsight never approves or blocks a pull request for you.
- **Shares lessons with the team.** Export the lessons and commit the file as `.hindsight/lessons.md`. Anyone reviewing that repository with Hindsight picks them up.

## Install

Download the latest `.msi` from the [Releases](../../releases) page and run it. Windows 10 or later, 64-bit.

The installer is not code-signed yet, so Windows SmartScreen will warn that the publisher is unknown. Choose **More info**, then **Run anyway**.

## Set up

Hindsight needs two keys, entered on the Settings screen:

1. **An Anthropic API key**, from <https://console.anthropic.com/settings/keys>. Reviews are billed to this key.
2. **A GitHub fine-grained access token**, from <https://github.com/settings/personal-access-tokens/new>, with these repository permissions:
   - Pull requests: read and write
   - Contents: read

Both are encrypted on your computer using Windows' own credential protection.

## Privacy

Hindsight has no server. Your keys, your lessons and your reviews stay on your computer. The app talks to two services only:

- **GitHub**, to read pull requests and post the reviews you choose to post.
- **Anthropic**, to which it sends the pull request's title, description and changes, plus your lessons, so Claude can review them.

## Limits

- GitHub only, for now.
- Very large pull requests are trimmed: lock files, generated files and anything past the size budget are listed as not reviewed.
- Claude can be wrong. Treat findings as a second opinion, not a verdict.

## Build from source

```
npm install
npm test
npm start        # run the app
npm run dist     # build the MSI (Windows only)
```

Pushing a tag such as `v0.1.0` builds the installer on GitHub Actions and attaches it to a release.

## Licence

MIT. See [LICENSE](LICENSE).
