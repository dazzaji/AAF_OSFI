# Deploying the pilot

The pilot is two small Node services. Each needs a public HTTPS hostname. Passkeys are tied to the directory's hostname, so choose it before anyone enrolls.

## 1. Configure

```bash
cp deploy/.env.example deploy/.env
```

Edit `deploy/.env`: the two public addresses, the operator's email, the mail settings and a long random shop admin token. `AAF_ENV=hosted` is set in the image: local stand-ins are off, invitations are only ever emailed, and the shop's admin actions need the token.

## 2. Start

```bash
docker compose -p aaf-pilot -f deploy/docker-compose.yml up -d --build
```

The services listen only inside the Compose network (directory on 4100, shop on 4200). Check them:

```bash
docker compose -p aaf-pilot -f deploy/docker-compose.yml ps
```

## 3. Publish over HTTPS

Either:

- **Cloudflare Tunnel** (no open ports, no certificates): create a tunnel with two public hostnames pointing at `http://directory:4100` and `http://shop:4200`, put its token in `deploy/.env`, and add `--profile tunnel` to the command in step 2.
- **Your own reverse proxy**: attach it to the `aaf-pilot_pilot` network and proxy the two hostnames to the same addresses.

If your proxy or CDN challenges automated clients, exempt the shop hostname and the directory's `/api/` and `/.well-known/` paths, or agents will be blocked.

## 4. Enroll the operator

The directory writes a one-time operator link on first start:

```bash
docker compose -p aaf-pilot -f deploy/docker-compose.yml exec directory cat /data/OPERATOR-INVITE.txt
```

Open it in a browser and create the operator's passkey. From then on, invite principals from the operator view.

## 5. Add a design while it runs

Copy a `.tsx` file into `skins/directory/` or `skins/shop/` on the host. It appears in the Design menu of open tabs within a few seconds.

## Rollback

```bash
docker compose -p aaf-pilot -f deploy/docker-compose.yml down
```

This stops the pilot and keeps its data volumes. Remove the two public hostnames from the tunnel or proxy. Always pass `-p aaf-pilot`, and never run host-wide Docker clean-up commands on a shared host.

## Closing the pilot

There is no automatic deletion. When the pilot ends, remove the volumes (`down -v`) to delete principal records, issuance records, cases and keys.
