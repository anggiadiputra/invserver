import express from 'express';

const router = express.Router();

// Base URL for Indonesian regions API
const API_BASE_URL = 'https://www.emsifa.com/api-wilayah-indonesia/api';

// Get all provinces
router.get('/provinces', async (req, res) => {
  try {
    const response = await fetch(`${API_BASE_URL}/provinces.json`);
    if (!response.ok) {
      throw new Error('Failed to fetch provinces');
    }
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching provinces:', error);
    res.status(500).json({ error: 'Failed to fetch provinces' });
  }
});

// Get regencies by province
router.get('/provinces/:provinceId/regencies', async (req, res) => {
  try {
    const response = await fetch(`${API_BASE_URL}/regencies/${req.params.provinceId}.json`);
    if (!response.ok) {
      throw new Error('Failed to fetch regencies');
    }
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching regencies:', error);
    res.status(500).json({ error: 'Failed to fetch regencies' });
  }
});

// Get districts by regency
router.get('/regencies/:regencyId/districts', async (req, res) => {
  try {
    const response = await fetch(`${API_BASE_URL}/districts/${req.params.regencyId}.json`);
    if (!response.ok) {
      throw new Error('Failed to fetch districts');
    }
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching districts:', error);
    res.status(500).json({ error: 'Failed to fetch districts' });
  }
});

// Get villages by district
router.get('/districts/:districtId/villages', async (req, res) => {
  try {
    const response = await fetch(`${API_BASE_URL}/villages/${req.params.districtId}.json`);
    if (!response.ok) {
      throw new Error('Failed to fetch villages');
    }
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching villages:', error);
    res.status(500).json({ error: 'Failed to fetch villages' });
  }
});

export default router;
