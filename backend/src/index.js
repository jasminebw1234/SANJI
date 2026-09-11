import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import documentRoutes from './routes/document.js';
import voiceRoutes from './routes/voices.js';
import { errorMiddleware } from './middleware/asyncHandler.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/documents', documentRoutes);
app.use('/api/voices', voiceRoutes);

// Must come after all routes — turns an async handler's rejection into a
// 500 for that request instead of an uncaught exception that kills the
// process.
app.use(errorMiddleware);

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
