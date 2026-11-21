# CloudBoard — 3-Tier AWS Shared Notes & File Hub

Lightweight, production-ready Node.js + Express application designed for an AWS 3-tier highly available architecture:

**Application Load Balancer** → **Auto Scaling Group (Amazon Linux 2023 `t3.micro` EC2)** → **Amazon EFS** → **Multi-AZ Amazon RDS PostgreSQL**

## Project Directory Structure

```text
cloudboard/
├── package.json
├── .env.example
├── .gitignore
├── README.md
├── server.js
├── public/
│   └── index.html
└── deploy/
    ├── cloudboard.service   # Install to /etc/systemd/system/cloudboard.service
    └── proxy.conf           # Install to /etc/httpd/conf.d/proxy.conf
```

## Quick Start (Amazon Linux 2023 EC2)

1. **Install Node.js, Apache (`httpd`), and EFS utilities:**
   ```bash
   sudo dnf update -y
   sudo dnf install -y nodejs httpd amazon-efs-utils
   ```

2. **Mount Amazon EFS (example for `/var/www/shared`):**
   ```bash
   sudo mkdir -p /var/www/shared
   sudo mount -t efs -o tls fs-XXXXXXXX:/ /var/www/shared
   sudo mkdir -p /var/www/shared/uploads
   sudo chown -R ec2-user:ec2-user /var/www/shared/uploads
   ```

3. **Deploy CloudBoard to `/var/www/cloudboard`:**
   ```bash
   sudo mkdir -p /var/www/cloudboard
   sudo chown -R ec2-user:ec2-user /var/www/cloudboard
   cp -r * .env.example /var/www/cloudboard/
   cd /var/www/cloudboard
   npm install --omit=dev
   cp .env.example .env
   # Edit .env with your RDS DATABASE_URL, DB_SSL=true, and UPLOAD_DIR=/var/www/shared/uploads
   chmod 600 .env
   ```

4. **Configure `systemd` and Apache reverse proxy:**
   ```bash
   sudo cp deploy/cloudboard.service /etc/systemd/system/cloudboard.service
   sudo cp deploy/proxy.conf /etc/httpd/conf.d/proxy.conf

   sudo systemctl daemon-reload
   sudo systemctl enable --now cloudboard

   sudo httpd -t
   sudo systemctl enable --now httpd
   ```

5. **Verify locally on the EC2 instance:**
   ```bash
   curl -i http://127.0.0.1/health
   curl -s http://127.0.0.1/api/status
   ```

## Local Development

```bash
npm install
cp .env.example .env
# Set DATABASE_URL to your local PostgreSQL instance, DB_SSL=false, and UPLOAD_DIR=./uploads
npm start
```

Open `http://127.0.0.1:3000`. When IMDSv2 is unavailable locally, the header falls back to `os.hostname()` and `local-dev`.
