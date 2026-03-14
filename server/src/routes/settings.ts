import { Router, Request, Response } from 'express';
import * as db from '../services/database';

const router = Router();

// GET /api/settings - Get all settings
router.get('/', (_req: Request, res: Response) => {
  try {
    const settings = db.getAllSettings();
    res.json(settings);
  } catch (error) {
    console.error('Failed to get settings:', error);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

// GET /api/settings/:key - Get a single setting
router.get('/:key', (req: Request, res: Response) => {
  try {
    const value = db.getSetting(req.params.key as string);
    if (value === undefined) {
      return res.status(404).json({ error: 'Setting not found' });
    }
    res.json({ key: req.params.key as string, value });
  } catch (error) {
    console.error('Failed to get setting:', error);
    res.status(500).json({ error: 'Failed to get setting' });
  }
});

// PUT /api/settings - Update multiple settings at once
router.put('/', (req: Request, res: Response) => {
  try {
    const settings = req.body as Record<string, string>;
    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: 'Settings object is required' });
    }
    for (const [key, value] of Object.entries(settings)) {
      db.setSetting(key, String(value));
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to update settings:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// PUT /api/settings/:key - Update a single setting
router.put('/:key', (req: Request, res: Response) => {
  try {
    const { value } = req.body as { value: string };
    if (value === undefined || value === null) {
      return res.status(400).json({ error: 'Value is required' });
    }
    db.setSetting(req.params.key as string, String(value));
    res.json({ key: req.params.key as string, value: String(value) });
  } catch (error) {
    console.error('Failed to update setting:', error);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

// DELETE /api/settings/:key - Delete a setting
router.delete('/:key', (req: Request, res: Response) => {
  try {
    db.deleteSetting(req.params.key as string);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete setting:', error);
    res.status(500).json({ error: 'Failed to delete setting' });
  }
});

export default router;
