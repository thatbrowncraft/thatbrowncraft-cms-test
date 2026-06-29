# thatbrowncraft — Test Repository

Test environment for the official Sveltia CMS + GitHub Pages migration.

**Live site:** https://thatbrowncraft.github.io/thatbrowncraft-cms-test  
**CMS dashboard:** https://thatbrowncraft.github.io/thatbrowncraft-cms-test/admin/

## Setup status

- [ ] Cloudflare Worker deployed — paste URL into `admin/config.yml` at `base_url`
- [ ] GitHub OAuth App created — Client ID and Secret added to Cloudflare Worker environment
- [ ] GitHub Pages enabled on this repository
- [ ] CMS login tested end to end

## One thing to do before going live

Open `admin/config.yml` and replace `PASTE_YOUR_WORKER_URL_HERE` with your deployed Cloudflare Worker URL.

> Do not use this repository for production content.  
> Production repository: thatbrowncraft/thatbrowncraft-website
