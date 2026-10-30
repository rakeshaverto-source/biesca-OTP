# Biesca OTP Login

WhatsApp OTP login API for the Biesca Shopify store. It sends OTPs through AiSensy and saves customers to Shopify. There is no database; OTPs are kept in memory.

Live at https://automation.avertomedia.com

## Routes

- `GET /health`
- `POST /otp/send`
- `POST /otp/verify`
- `POST /session`

The Shopify theme calls these routes, so do not rename them or change their responses.

## Run locally

```bash
npm install
cp .env.example .env   # then set TOKEN_SECRET (openssl rand -hex 32)
npm start
```

## First deploy (Ubuntu VPS)

```bash
git clone https://github.com/rakeshaverto-source/biesca-OTP.git /var/www/biesca-otp
cd /var/www/biesca-otp
npm install --omit=dev
cp .env.example .env && chmod 600 .env
# Set TOKEN_SECRET, AISENSY_API_KEY and SHOPIFY_ADMIN_TOKEN with: nano .env
pm2 start server.js --name biesca-otp
pm2 save
pm2 startup
```

Run it as a single pm2 instance (fork mode), never cluster. Each process keeps its own OTPs in memory.

nginx proxies `automation.avertomedia.com` to `http://127.0.0.1:3005`, and certbot provides HTTPS.

## Update

```bash
bash /var/www/biesca-otp/deploy.sh
```

Restarting clears OTPs in memory, so anyone mid-login just requests a new OTP. Logged-in customers stay logged in.

## Never commit `.env`

It holds the API keys. It is listed in `.gitignore` and exists only on the server.
