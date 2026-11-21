'use strict';

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const HOST = '127.0.0.1';
const PORT = parseInt(process.env.PORT, 10) || 3000;
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || '/var/www/shared/uploads');
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const IMDS_HOST = '169.254.169.254';
const IMDS_TIMEOUT_MS = 1000;

// Ensure shared EFS upload directory exists on startup
try {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
} catch (err) {
  console.error(`[EFS] Warning: could not create upload directory "${UPLOAD_DIR}":`, err.message);
}

// ---------------------------------------------------------------------------
// PostgreSQL Connection Pool (Amazon RDS)
// ---------------------------------------------------------------------------
const dbSslEnabled = String(process.env.DB_SSL).toLowerCase() === 'true';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: dbSslEnabled ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected idle client error:', err.message);
});

let schemaInitialized = false;

async function initDatabase() {
  if (!process.env.DATABASE_URL) {
    console.warn('[DB] DATABASE_URL is not set. Database endpoints will fail until configured.');
    return false;
  }

  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS notes (
      id SERIAL PRIMARY KEY,
      title VARCHAR(120) NOT NULL,
      content TEXT NOT NULL,
      attachment_name VARCHAR(255),
      created_by_az VARCHAR(32),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `;

  try {
    await pool.query(createTableSQL);
    schemaInitialized = true;
    console.log('[DB] Schema verified (notes table ready).');
    return true;
  } catch (err) {
    console.error('[DB] Schema initialization failed:', err.message);
    return false;
  }
}

async function ensureSchema() {
  if (!schemaInitialized) {
    await initDatabase();
  }
}

// ---------------------------------------------------------------------------
// AWS EC2 IMDSv2 Metadata Helper (1-second timeout + local fallback)
// ---------------------------------------------------------------------------
function imdsRequest(method, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: IMDS_HOST,
        port: 80,
        path: reqPath,
        method,
        headers,
        timeout: IMDS_TIMEOUT_MS,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body.trim());
          } else {
            reject(new Error(`IMDS HTTP ${res.statusCode} for ${reqPath}`));
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`IMDS request timed out after ${IMDS_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

function getLocalFallbackIp() {
  const interfaces = os.networkInterfaces();
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  return '127.0.0.1';
}

let cachedMetadata = null;

async function getInstanceMetadata() {
  if (cachedMetadata) {
    return cachedMetadata;
  }

  try {
    const token = await imdsRequest('PUT', '/latest/api/token', {
      'X-aws-ec2-metadata-token-ttl-seconds': '21600',
    });

    const tokenHeader = { 'X-aws-ec2-metadata-token': token };
    const [instanceId, availabilityZone, privateIp] = await Promise.all([
      imdsRequest('GET', '/latest/meta-data/instance-id', tokenHeader),
      imdsRequest('GET', '/latest/meta-data/placement/availability-zone', tokenHeader),
      imdsRequest('GET', '/latest/meta-data/local-ipv4', tokenHeader),
    ]);

    cachedMetadata = {
      instanceId,
      availabilityZone,
      privateIp,
      source: 'imds-v2',
    };
  } catch (_err) {
    cachedMetadata = {
      instanceId: os.hostname(),
      availabilityZone: 'local-dev',
      privateIp: getLocalFallbackIp(),
      source: 'local-fallback',
    };
  }

  return cachedMetadata;
}

// ---------------------------------------------------------------------------
// Multer Upload Configuration (Amazon EFS)
// ---------------------------------------------------------------------------
function sanitizeFilename(originalName) {
  const base = path.basename(originalName || 'file');
  const ext = path.extname(base).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 16);
  const rawStem = path.basename(base, path.extname(base));
  const safeStem = rawStem
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'upload';

  const uniquePrefix = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  return `${uniquePrefix}-${safeStem}${ext}`;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdir(UPLOAD_DIR, { recursive: true }, (err) => {
      if (err) return cb(err);
      return cb(null, UPLOAD_DIR);
    });
  },
  filename: (_req, file, cb) => {
    cb(null, sanitizeFilename(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 1,
  },
});

// ---------------------------------------------------------------------------
// Express App & Middleware
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Lightweight security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json({ limit: '100kb' }));

// Static frontend assets
app.use(express.static(path.join(__dirname, 'public')));

// Shared EFS uploads served from /uploads
app.use(
  '/uploads',
  express.static(UPLOAD_DIR, {
    dotfiles: 'deny',
    index: false,
    setHeaders: (res, filePath) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      const ext = path.extname(filePath).toLowerCase();
      if (['.html', '.htm', '.svg', '.xhtml', '.xml'].includes(ext)) {
        res.setHeader('Content-Disposition', 'attachment');
      }
    },
  })
);

// ---------------------------------------------------------------------------
// Health Check & Live Tier Diagnostics
// ---------------------------------------------------------------------------

// Fast ALB Target Group health check (must respond immediately with 200 OK)
app.get('/health', (_req, res) => {
  res.status(200).type('text/plain').send('OK');
});

async function checkEfsWritability() {
  const probeFile = path.join(
    UPLOAD_DIR,
    `.efs-probe-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  );
  try {
    await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
    await fs.promises.writeFile(probeFile, 'ok', 'utf8');
    await fs.promises.unlink(probeFile);
    return 'writable';
  } catch (_err) {
    return 'error';
  }
}

async function checkDatabaseConnectivity() {
  if (!process.env.DATABASE_URL) {
    return 'error';
  }
  try {
    await pool.query('SELECT 1');
    return 'connected';
  } catch (_err) {
    return 'error';
  }
}

app.get('/api/status', async (_req, res) => {
  const [metadata, database, efs] = await Promise.all([
    getInstanceMetadata(),
    checkDatabaseConnectivity(),
    checkEfsWritability(),
  ]);

  res.json({
    database,
    efs,
    instanceId: metadata.instanceId,
    availabilityZone: metadata.availabilityZone,
    privateIp: metadata.privateIp,
    metadataSource: metadata.source,
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Notes REST API
// ---------------------------------------------------------------------------

// List all notes (newest first)
app.get('/api/notes', async (_req, res) => {
  try {
    await ensureSchema();
    const { rows } = await pool.query(
      `SELECT id, title, content, attachment_name, created_by_az, created_at
       FROM notes
       ORDER BY created_at DESC, id DESC`
    );
    return res.json({ notes: rows });
  } catch (err) {
    console.error('[API] GET /api/notes error:', err.message);
    return res.status(500).json({ error: 'Failed to load notes from database.' });
  }
});

// Create a note with optional EFS file attachment
app.post('/api/notes', (req, res, next) => {
  upload.single('attachment')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Attachment exceeds the 5 MB size limit.' });
      }
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    console.error('[EFS] File upload failed:', err.message);
    return res.status(500).json({ error: 'Failed to save attachment to shared storage.' });
  });
}, async (req, res) => {
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
  const uploadedFile = req.file ? req.file.filename : null;

  const cleanupUploadedFile = async () => {
    if (!uploadedFile) return;
    const safePath = path.join(UPLOAD_DIR, path.basename(uploadedFile));
    await fs.promises.unlink(safePath).catch(() => {});
  };

  if (!title || !content) {
    await cleanupUploadedFile();
    return res.status(400).json({ error: 'Both title and content are required.' });
  }

  if (title.length > 120) {
    await cleanupUploadedFile();
    return res.status(400).json({ error: 'Title must be 120 characters or fewer.' });
  }

  try {
    await ensureSchema();
    const metadata = await getInstanceMetadata();
    const createdByAz = String(metadata.availabilityZone || 'unknown').slice(0, 32);

    const { rows } = await pool.query(
      `INSERT INTO notes (title, content, attachment_name, created_by_az)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, content, attachment_name, created_by_az, created_at`,
      [title, content, uploadedFile, createdByAz]
    );

    return res.status(201).json({ note: rows[0] });
  } catch (err) {
    await cleanupUploadedFile();
    console.error('[API] POST /api/notes error:', err.message);
    return res.status(500).json({ error: 'Failed to save note to database.' });
  }
});

// Delete a note and remove its EFS attachment if present
app.delete('/api/notes/:id', async (req, res) => {
  const noteId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(noteId) || noteId <= 0 || String(noteId) !== req.params.id) {
    return res.status(400).json({ error: 'Invalid note ID.' });
  }

  try {
    await ensureSchema();
    const { rows } = await pool.query(
      'DELETE FROM notes WHERE id = $1 RETURNING id, attachment_name',
      [noteId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Note not found.' });
    }

    const attachmentName = rows[0].attachment_name;
    if (attachmentName) {
      const safePath = path.join(UPLOAD_DIR, path.basename(attachmentName));
      await fs.promises.unlink(safePath).catch((unlinkErr) => {
        if (unlinkErr.code !== 'ENOENT') {
          console.warn(`[EFS] Could not delete attachment "${attachmentName}":`, unlinkErr.message);
        }
      });
    }

    return res.json({ deleted: true, id: noteId });
  } catch (err) {
    console.error('[API] DELETE /api/notes/:id error:', err.message);
    return res.status(500).json({ error: 'Failed to delete note.' });
  }
});

// ---------------------------------------------------------------------------
// Startup & Graceful Shutdown
// ---------------------------------------------------------------------------
async function startServer() {
  const metadata = await getInstanceMetadata();
  await initDatabase();

  const server = app.listen(PORT, HOST, () => {
    console.log(
      `[CloudBoard] Listening on http://${HOST}:${PORT} | Instance: ${metadata.instanceId} | AZ: ${metadata.availabilityZone} | IP: ${metadata.privateIp}`
    );
  });

  const shutdown = (signal) => {
    console.log(`[CloudBoard] Received ${signal}. Shutting down gracefully...`);
    server.close(async () => {
      try {
        await pool.end();
      } catch (err) {
        console.error('[DB] Error closing pool:', err.message);
      }
      process.exit(0);
    });

    // Force exit if connections hang beyond 10s
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  startServer();
}

module.exports = { app, sanitizeFilename, getInstanceMetadata };
