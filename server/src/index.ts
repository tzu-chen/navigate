import express from 'express';
import cors from 'cors';
import path from 'path';
import { initializeDatabase } from './services/database';
import { initializePdfStorage } from './services/pdf';
import arxivRoutes from './routes/arxiv';
import papersRoutes from './routes/papers';
import tagsRoutes from './routes/tags';
import exportRoutes from './routes/export';
import authorsRoutes from './routes/authors';
import chatRoutes from './routes/chat';
import worldlinesRoutes from './routes/worldlines';
import settingsRoutes from './routes/settings';
import scribeRoutes from './routes/scribe';

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '127.0.0.1';

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// API Routes
app.use('/api/arxiv', arxivRoutes);
app.use('/api/papers', papersRoutes);
app.use('/api/tags', tagsRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/authors', authorsRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/worldlines', worldlinesRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/scribe', scribeRoutes);

// Serve static frontend in production
const clientBuildPath = path.join(__dirname, '..', '..', 'client', 'dist');
app.use(express.static(clientBuildPath));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientBuildPath, 'index.html'));
});

// Initialize database and start server
initializeDatabase();
initializePdfStorage();
console.log('Database initialized');

app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});

export default app;
