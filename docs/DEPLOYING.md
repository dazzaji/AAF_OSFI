# Deploying the pilot

The pilot is two small Node services. Each needs a public HTTPS hostname. Passkeys are tied to the directory's hostname, so choose it before anyone enrolls.

The Compose file never builds: you load one image, then start exactly that image. It publishes no host ports.

## 0. The agent ZIP and its checksum

The Directory's setup pages (`/setup`, `/skill.md`, the strip on its home page) link to one release asset and print its SHA-256. Both come from `config/agent-release.json`, which is part of the image.

```bash
npm ci
npm run agent-zip -- --check     # rebuilds dist/aaf-agent-v<version>.zip and compares it with the committed SHA-256
```

For a new version: change the version, tag, asset name and address in `config/agent-release.json` and in `skill/aaf-agent/` (`SKILL.md`, `README.md`), bump `VERSION` in `src/agent/client.js`, run `npm run agent-zip -- --write`, and commit. The ZIP is built only from `src/agent`, `src/core`, `skill/aaf-agent`, `LICENSE`, `NOTICE` and the lockfile-pinned packages, with entries stored uncompressed and fixed timestamps, so the same commit and the same `npm ci` give the same bytes. Attach that file to the GitHub release named by the tag and put the SHA-256 in the release notes. The `paths` entries in the same file are the "what has been verified" table on the setup guide: mark a path verified only after a fresh setup reached a first quote that way.

## 1. Build and load the image

On any machine with Docker, from the repository root:

```bash
docker buildx build --platform linux/amd64 -f deploy/Dockerfile -t aaf-osfi:$(git rev-parse --short HEAD) --load .
```

Copy it to the host with `docker save` and `docker load`. Copy `deploy/`, `skins/`, `datasets/` and `config/` from the same commit into one release folder on the host; the Compose file mounts those three folders read-only, so a design, sample dataset or shop policy can be changed while the pilot runs.

To upgrade a running pilot, load the new image, put the new release folder beside the old one, back up both volumes with the two services stopped, and start the new image on the same volumes with the same four variables you used before (`AAF_BUILD` changes; `AAF_ENV_FILE`, `AAF_TUNNEL_TOKEN_FILE` and `AAF_MAIL_SECRETS_DIR` do not). Pass them explicitly: a missing `AAF_MAIL_SECRETS_DIR` makes the mail key unreadable and the directory refuses to start. Version 0.2.0 changes no database schema, so the previous image can be started on the same volumes to roll back.

## 2. Configure

Copy `deploy/.env.example` to a file outside Git and fill it in:

- the two public addresses, and the same two in `AAF_TRUSTED_DIRECTORIES` and `AAF_TRUSTED_COUNTERPARTIES`. A hosted service refuses to start without them;
- the operator's email, which should differ from the address you will later invite yourself at;
- a long random `AAF_SHOP_ADMIN_TOKEN`;
- mail: `AAF_MAIL_FROM` and `AAF_RESEND_KEY_FILE`. Put the Resend API key in a file owned by user 1000, mode 0400, in a folder of its own that user 1000 can enter (for example mode 0500, owned by 1000); set `AAF_MAIL_SECRETS_DIR` to that folder when starting Compose and `AAF_RESEND_KEY_FILE=/run/aaf-mail/<file name>` in the env file. A key file that is named but unreadable stops the directory from starting. Without a mail service you can set `AAF_INVITE_FALLBACK=operator-link`: each invitation link is then shown once to the operator, and principals enrolled that way are recorded with no mailbox assurance.

`AAF_ENV=hosted` is set in the image: local stand-ins are off, the decision feed is private, and the shop's admin actions need the token.

## 3. Start

```bash
AAF_BUILD=<short commit> AAF_ENV_FILE=/abs/path/pilot.env docker compose -p aaf-osfi -f deploy/docker-compose.yml up -d --no-build --wait
```

The services listen only inside the Compose network (directory on 4100, shop on 4200).

## 4. Publish over HTTPS

Either:

- **Cloudflare Tunnel** (no open ports, no certificates): create a tunnel with two public hostnames pointing at `http://directory:4100` and `http://shop:4200`, save its token in a file, set `AAF_TUNNEL_TOKEN_FILE` to that file's path, and add `--profile tunnel` to the command in step 3. The connector runs as user 65532 with no extra privileges, so the token file must be owned by 65532 and mode 0400 (keep it in a directory only root can enter). Start the connector and look for "Registered tunnel connection" in its log before you create the DNS records.
- **Your own reverse proxy**: attach it to the `aaf-osfi_pilot` network and proxy the two hostnames to the same addresses.

Both services fetch each other's keys and status at their public addresses. On one host you can keep that traffic off the public path with `AAF_INTERNAL_ROUTES=https://aaf-dir.example.org=http://directory:4100,https://aaf-shop.example.org=http://shop:4200`: only the connection is redirected; every issuer, audience and allow-list check still uses the public address. Do not attach other containers to the pilot's network while routes are on.

If your proxy or CDN challenges automated clients, exempt the shop hostname and the directory's `/api/` and `/.well-known/` paths, or agents and the shop's status polling will be blocked.

## 5. Enroll the operator

The directory writes a one-time operator link on first start. It is never printed to the logs:

```bash
docker compose -p aaf-osfi -f deploy/docker-compose.yml exec directory cat /data/OPERATOR-INVITE.txt
```

Open it in a browser and create the operator's passkey. From then on, invite principals from the operator view.

## 6. Add a design while it runs

Copy a `.tsx` file into `skins/directory/` or `skins/shop/` in the release folder on the host. It appears in the Design menu of open tabs within a few seconds.

## Private staging before any DNS exists

`deploy/docker-compose.stage.yml` runs the same image as a scratch project on the host's loopback, with both services sharing one network namespace. Use a separate env file with `AAF_STAGING=1` and the two addresses set to `http://localhost:14100` and `http://localhost:14200`. Reach it through an SSH tunnel for those two ports; the browser's origin then equals the configured passkey origin. `AAF_STAGING` permits plain-HTTP `localhost` addresses and nothing else. Never set it in the public env file.

## Rollback

```bash
docker compose -p aaf-osfi -f deploy/docker-compose.yml --profile tunnel stop
```

This stops the pilot and keeps its data volumes. Then delete the two DNS records and the tunnel, delete the tunnel token file, and check that the two names no longer resolve (allow for DNS caches) and that no scratch volumes from staging remain (`docker volume ls`). Always pass `-p aaf-osfi`, and never run host-wide Docker clean-up commands on a shared host.

## Backup

Each service keeps a SQLite database, `signing-key.json`, and (directory only) `secrets.json` in its data volume. A backup needs all of them: a database restored without the key files would start with new keys and could not verify earlier receipts or credentials.

## Closing the pilot

There is no automatic deletion. When the pilot ends, remove the volumes (`down -v`) to delete principal records, issuance records, cases and keys.
