# Free Live Deployment (GitHub + OCI Always Free)

This is the lowest-cost path to keep the full mCryptoEx stack online:

- GitHub (source + CI)
- Oracle Cloud Always Free VM (hosts full Docker stack)
- Caddy (automatic TLS for public domain)
- Optional Cloudflare Free DNS in front of VM

The deployment keeps wallet-first, non-custodial execution. No server-side trade signing is introduced.

## 1) Publish repository to GitHub

From local repository:

```bash
git add .
git commit -m "chore: add OCI live deploy flow"
git push origin main
```

## 2) Provision Oracle Cloud Always Free VM

Create one Ubuntu VM and open inbound ports:

- `22` (SSH)
- `80` (HTTP)
- `443` (HTTPS)

Recommended minimum shape for this stack:

- 2 OCPU
- 12 GB RAM (or the largest Always Free shape available to your account)

## 3) Install runtime on VM

Run once on the VM:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git python3 python3-pip
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"
newgrp docker
docker --version
docker compose version
```

## 4) Prepare production env on VM

Clone project and create env:

```bash
git clone https://github.com/<org>/<repo>.git ~/mcryptoex
cd ~/mcryptoex
cp .env.example .env
```

Set at least these keys in `.env`:

- `PUBLIC_DOMAIN=your-domain.com`
- `ACME_EMAIL=you@domain.com`
- `CORS_ORIGINS=https://your-domain.com`
- `SEPOLIA_RPC_URL=...`
- `BSC_TESTNET_RPC_URL=...`
- `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=...`
- `PRIVATE_KEY=...` (deployer key, local VM only)

Never commit `.env` or private keys.

## 5) DNS

Point domain A record to VM public IP:

- `your-domain.com -> <VM_PUBLIC_IP>`

Wait for DNS propagation before first TLS issuance.

## 6) First live deployment (manual)

```bash
cd ~/mcryptoex
bash scripts/deploy/live-oci.sh
```

This runs:

1. chain registry generation
2. full stack compose build/up with live overlay
3. Caddy gateway on `:80/:443`

## 7) GitHub Actions auto-deploy

Workflow file:

- `.github/workflows/deploy-oci-live.yml`

Add repository secrets:

- `OCI_HOST` - VM public IP or DNS
- `OCI_USER` - SSH username
- `OCI_SSH_KEY` - private key contents for SSH
- `OCI_APP_DIR` - optional, default `~/mcryptoex`
- `OCI_REPO_URL` - optional (use for private repo clone URL with token/deploy key setup)

One-shot helper (sets secrets and can dispatch workflow):

```bash
cd ~/mcryptoex
OCI_HOST=<vm-ip-or-dns> \
OCI_USER=ubuntu \
OCI_SSH_KEY="$(cat ~/.ssh/id_ed25519)" \
scripts/deploy/set-gh-oci-secrets.sh WeAreTheArtMakers/mcryptoex true
```

Workflow is configured as **manual** (`workflow_dispatch`) by default.
After secrets are set, run it from GitHub Actions UI.

If you want full auto deploy on each `main` push, add a `push` trigger in
`.github/workflows/deploy-oci-live.yml`.

The workflow SSHes into VM and runs:

```bash
bash scripts/deploy/live-oci.sh
```

## 8) Public endpoints

After success:

- Web: `https://your-domain.com`
- API health: `https://your-domain.com/api/health`

## 9) Operational notes

- Free tiers can still have provider-level limits and capacity variation.
- If VM resources are insufficient, increase swap or reduce optional services.
- Keep private keys only in VM `.env` / CI secrets; never in git.
