const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { getProjects, getBranchesByProjectId, getProjectStatesByBranchId, searchProjectStates } = require('../utils/projectQueries');
const { getLLMRequestDetailsByProjectStateId, getEpicDetailsByProjectStateId, getTaskDetailsByProjectStateId, getStepDetailsByProjectStateId, getFileDetailsByProjectStateId, getUserInputDetailsByProjectStateId, getIterationDetailsByProjectStateId } = require('../utils/detailQueries');
const router = express.Router();

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log('Uploads directory created.');
}

// Set up storage engine
const storage = multer.diskStorage({
  destination: function(req, file, cb) {
    cb(null, uploadsDir)
  },
  filename: function(req, file, cb) {
    // Allow files without an extension
    const filename = file.fieldname + '-' + Date.now() + (path.extname(file.originalname) ? path.extname(file.originalname) : '');
    cb(null, filename);
  }
});

// Initialize upload variable with Multer settings
const upload = multer({
  storage: storage,
  fileFilter: function(req, file, cb) {
    // Accept .db, .sqlite, .sqlite3 files and files without an extension
    const filetypes = /\.(sqlite|sqlite3|db)$/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase()) || path.extname(file.originalname) === '';
    if (extname) {
      return cb(null, true);
    } else {
      cb(new Error('Error: File upload only supports the following filetypes - .db, .sqlite, .sqlite3 or files without an extension'));
    }
  },
  limits: { fileSize: 1000000000 }
}).single('databaseFile'); // Accept a single file with the field name 'databaseFile'

router.use(express.json());
router.use(express.urlencoded({ extended: true }));

// Root route
router.get('/', (req, res) => {
  fs.readdir(uploadsDir, (err, files) => {
    if (err) {
      console.error(`Failed to read uploads directory: ${err}`);
      return res.status(500).send('Error reading uploads directory');
    }
    // Include files without an extension in the list
    const databases = files.filter(file => /\.(sqlite|sqlite3|db)$/.test(path.extname(file).toLowerCase()) || path.extname(file) === '');
    res.render('index', { databases });
  });
});

// Select database route
router.post('/select-database', (req, res) => {
  const selectedDatabase = req.body.selectedDatabase;
  if (!selectedDatabase) {
    return res.status(400).send('No database selected');
  }
  const dbPath = path.join(uploadsDir, selectedDatabase);
  global.dbPath = dbPath; // Replace global variable with secure storage mechanism
  console.log(`Database selected: ${selectedDatabase}`);
  res.redirect('/projects');
});

// Rename database route
router.post('/rename-database', (req, res) => {
  const oldName = req.body.oldName;
  const newName = req.body.newName;
  if (!oldName || !newName) {
    return res.status(400).send('Old name and new name must be provided');
  }
  const oldPath = path.join(uploadsDir, oldName);
  const newPath = path.join(uploadsDir, newName);
  fs.rename(oldPath, newPath, (err) => {
    if (err) {
      console.error(`Failed to rename database from ${oldName} to ${newName}: ${err}`);
      return res.status(500).send('Error renaming database');
    }
    console.log(`Database renamed from ${oldName} to ${newName}`);
    res.redirect('/');
  });
});

// File upload route
router.post('/upload', (req, res) => {
  upload(req, res, (err) => {
    if (err) {
      console.error(`File upload error: ${err}`);
      return res.status(500).send(err.message);
    }
    if (req.file == undefined) {
      console.log('No file selected.');
      return res.status(400).send('Error: No file selected');
    } else {
      console.log(`File uploaded successfully: ${req.file.filename}`);
      // Attempt to open the uploaded database file to verify it's a valid SQLite file
      const dbPath = path.join(uploadsDir, req.file.filename);
      const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (dbErr) => {
        if (dbErr) {
          console.error(`Error opening database file: ${dbErr.message}`);
          fs.unlink(dbPath, (unlinkErr) => {
            if (unlinkErr) console.error(`Error removing invalid database file: ${unlinkErr.message}`);
            else console.log(`Invalid database file removed: ${req.file.filename}`);
          });
          return res.status(400).send('Error: Uploaded file is not a valid SQLite database');
        } else {
          console.log(`Database file verified successfully: ${req.file.filename}`);
          db.close();
          // Store the database path in a session or a secure place
          // For this example, we'll simulate storing the path in a global variable
          // IMPORTANT: This is not a secure practice and should be replaced with a session or similar approach
          global.dbPath = dbPath; // Replace global variable with secure storage mechanism
          res.redirect('/projects');
        }
      });
    }
  });
});

// Projects route
router.get('/projects', async (req, res) => {
  const dbPath = global.dbPath;
  if (!dbPath) {
    return res.status(400).send('No database file specified.');
  }
  try {
    let projects = await getProjects(dbPath);
    let branches = [];
    let projectStates = [];
    let selectedProjectId = req.query.projectId;
    let selectedBranchId = req.query.branchId;
    let { task, epic, iteration, llm_request, agent } = req.query;

    projects.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    if (!selectedProjectId && projects.length > 0) {
      selectedProjectId = projects[0].id; // Preselect the latest project if none is selected
      branches = await getBranchesByProjectId(dbPath, selectedProjectId);
      // Sort branches by created_at DESC to preselect the latest branch
      branches.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      if (branches.length > 0) {
        selectedBranchId = branches[0].id; // Preselect the latest branch
      }
    } else if (selectedProjectId) {
      branches = await getBranchesByProjectId(dbPath, selectedProjectId);
      branches.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      if (branches.length > 0) {
        selectedBranchId = branches[0].id; // Preselect the latest branch
      }

      if (selectedBranchId) {
        if (task || epic || iteration || agent) {
          projectStates = await searchProjectStates(dbPath, { task, epic, iteration, llm_request, agent, branchId: selectedBranchId });
        } else {
          projectStates = await getProjectStatesByBranchId(dbPath, selectedBranchId);
        }
      }
    }

    res.render('projects', { projects, branches, projectStates, selectedProjectId, selectedBranchId, task, epic, iteration, llm_request, agent });
  } catch (error) {
    console.error(`Failed to fetch projects, branches, or project states: ${error}`);
    res.status(500).send('Error fetching data');
  }
});

// Detailed data view route for LLM requests
router.get('/details/llm-requests/:projectStateId', async (req, res) => {
  const { projectStateId } = req.params;
  const dbPath = global.dbPath;
  if (!dbPath) {
    return res.status(400).send('No database file specified.');
  }
  try {
    const details = await getLLMRequestDetailsByProjectStateId(dbPath, projectStateId);
    res.render('details/llmRequests', { details });
  } catch (error) {
    console.error(`Failed to fetch LLM request details for project state ID ${projectStateId}: ${error}`);
    res.status(500).send('Error fetching LLM request details');
  }
});

// Route for fetching detailed data for project state columns
router.get('/details/:column/:projectStateId', async (req, res) => {
  const { column, projectStateId } = req.params;
  const dbPath = global.dbPath;
  if (!dbPath) {
    return res.status(400).send('No database file specified.');
  }
  try {
    let details;
    switch(column) {
      case 'epic':
        details = await getEpicDetailsByProjectStateId(dbPath, projectStateId);
        res.render('details/epicDetails', { details });
        break;
      case 'task':
        details = await getTaskDetailsByProjectStateId(dbPath, projectStateId);
        res.render('details/taskDetails', { details });
        break;
      case 'step':
        details = await getStepDetailsByProjectStateId(dbPath, projectStateId);
        res.render('details/stepDetails', { details });
        break;
      case 'files':
        details = await getFileDetailsByProjectStateId(dbPath, projectStateId);
        res.render('details/fileDetails', { details });
        break;
      case 'userInputs':
        details = await getUserInputDetailsByProjectStateId(dbPath, projectStateId);
        res.render('details/userInputDetails', { details });
        break;
      case 'llmRequests':
        details = await getLLMRequestDetailsByProjectStateId(dbPath, projectStateId);
        res.render('details/llmRequests', { details });
        break;
      case 'iteration':
        details = await getIterationDetailsByProjectStateId(dbPath, projectStateId);
        res.render('details/iterationDetails', { details });
        break;
      default:
        res.status(400).send('Invalid detail request');
    }
  } catch (error) {
    console.error(`Failed to fetch details for column ${column} and project state ID ${projectStateId}: ${error}`);
    res.status(500).send('Error fetching column details');
  }
});

// Route for deleting a database file
router.post('/delete-database', (req, res) => {
  const { databaseName } = req.body;
  if (!databaseName) {
    return res.status(400).send('Database name is required for deletion.');
  }
  const dbPath = path.join(uploadsDir, databaseName);
  if (global.dbPath === dbPath) {
    console.log('Attempt to delete the currently loaded database. Operation not allowed.');
    return res.status(400).send('Deletion of the currently loaded database is not allowed.');
  }
  fs.unlink(dbPath, (err) => {
    if (err) {
      console.error(`Failed to delete database file: ${databaseName}: ${err}`);
      return res.status(500).send('Error deleting database file.');
    }
    console.log(`Database file deleted successfully: ${databaseName}`);
    res.redirect('/');
  });
});

module.exports = router;