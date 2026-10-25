# Security

## Reporting a vulnerability

Please don't open a public issue. Report it privately instead:
- on GitHub: the repository's **Security** tab → **Report a vulnerability**, or
- by email: **security@durely.app**.

Describe what you found and how to reproduce it. **Leave out your API key, tokens and your own Garmin data**: invented values are enough, and the project's tests show how to fake them.

You'll get a reply within a week. Fixes go into a new release, and the advisory credits you unless you'd rather stay anonymous.

## Supported versions

Only the latest release gets security fixes.

## Scope

In scope: this server, its Docker image, and how it handles your key, token and local cache.

Out of scope: Garmin's own API and website. Report those to Garmin.

## If your key leaked

Revoke it in Garmin Connect under [Settings → Personal API Token](https://connect.garmin.com/app/settings/personalApiToken) and create a new one. The server picks up the new key file without a restart.
