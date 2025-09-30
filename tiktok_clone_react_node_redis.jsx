# TikTok-like App — Full Project (React + Node + Socket.IO + Redis)

This repository contains a full, minimal but production-minded implementation of a TikTok-style app with:

- Real-time **Following** and **Trending** feed updates using **Socket.IO** and **Redis** adapter (horizontal scale-ready).
- Background trending job (cron) that computes trending videos in batches.
- Optimized Socket.IO rooms so only followers receive uploads; trending goes to a `trending` room.
- REST APIs for auth (JWT), videos, likes, comments, follows.
- Responsive and attractive UI built with **React + TailwindCSS** (single-file React app structure for brevity).
- Local file upload (Multer) with clear spots to replace with S3/Cloudinary.

---

## Project structure

```
/tiktok-clone
  /backend
    package.json
    .env.example
    server.js
    socket.js
    redisClient.js
    /models
      User.js
      Video.js
    /routes
      authRoutes.js
      userRoutes.js
      videoRoutes.js
    /controllers
      authController.js
      userController.js
      videoController.js
    trendingJob.js
  /frontend
    package.json
    /src
      main.jsx
      App.jsx
      socket.js
      /pages
        Feed.jsx
        FollowingFeed.jsx
        TrendingFeed.jsx
        Upload.jsx
        Auth.jsx
      /components
        VideoCard.jsx
        Navbar.jsx
      index.css
    tailwind.config.cjs
  README.md
```

---

> **Note:** This code is designed to be readable and copy-paste runnable. Replace example secrets in `.env` before running.

---

## Backend — Files

### backend/package.json

```json
{
  "name": "tiktok-backend",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "cors": "^2.8.5",
    "dotenv": "^16.0.0",
    "express": "^4.18.2",
    "jsonwebtoken": "^9.0.0",
    "mongoose": "^7.0.0",
    "multer": "^1.4.5-lts.1",
    "socket.io": "^4.8.0",
    "@socket.io/redis-adapter": "^7.0.0",
    "ioredis": "^5.3.1",
    "node-cron": "^3.0.2"
  },
  "devDependencies": {
    "nodemon": "^2.0.22"
  }
}
```

---

### backend/.env.example

```
PORT=5000
MONGO_URI=mongodb://localhost:27017/tiktok
JWT_SECRET=replace_with_strong_secret
REDIS_URL=redis://localhost:6379
FRONTEND_URL=http://localhost:5173
TREND_THRESHOLD=50
```

---

### backend/redisClient.js

```js
import { createClient } from "ioredis";
import dotenv from "dotenv";
dotenv.config();

const redis = createClient({ url: process.env.REDIS_URL });
redis.on("error", (err) => console.error("Redis error", err));
await redis.connect();

export default redis;
```

---

### backend/socket.js

```js
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "ioredis";

export async function setupSocket(io, app) {
  // setup redis adapter for scaling
  const pubClient = createClient({ url: process.env.REDIS_URL });
  const subClient = pubClient.duplicate();
  await pubClient.connect();
  await subClient.connect();

  io.adapter(createAdapter(pubClient, subClient));

  io.on("connection", (socket) => {
    console.log("Socket connected:", socket.id);

    socket.on("register", (userId) => {
      socket.join(`user_${userId}`); // personal room
      socket.join("trending"); // all users subscribe to trending
      console.log(`Socket ${socket.id} joined user_${userId} and trending`);
    });

    socket.on("disconnect", () => {
      console.log("Socket disconnected:", socket.id);
    });
  });

  // expose io on app for controllers
  app.set("io", io);
}
```

---

### backend/server.js

```js
import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import { Server } from "socket.io";
import { setupSocket } from "./socket.js";
import cron from "node-cron";
import { processTrending } from "./trendingJob.js";

import authRoutes from "./routes/authRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import videoRoutes from "./routes/videoRoutes.js";

dotenv.config();
const app = express();
const httpServer = createServer(app);

app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(express.json());
app.use('/uploads', express.static('uploads'));

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error(err));

const io = new Server(httpServer, { cors: { origin: process.env.FRONTEND_URL } });
await setupSocket(io, app);

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/videos', videoRoutes);

// Cron job: process trending every 2 minutes
cron.schedule("*/2 * * * *", async () => {
  console.log('Running trending job...');
  await processTrending(app.get('io'));
});

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => console.log(`Server running on ${PORT}`));
```

---

### backend/models/User.js

```js
import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  passwordHash: String,
  followers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
}, { timestamps: true });

export default mongoose.model('User', userSchema);
```

---

### backend/models/Video.js

```js
import mongoose from "mongoose";

const videoSchema = new mongoose.Schema({
  title: String,
  url: String,
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  likes: { type: Number, default: 0 },
  comments: [{ user: String, text: String }],
}, { timestamps: true });

export default mongoose.model('Video', videoSchema);
```

---

### backend/controllers/authController.js

```js
import User from '../models/User.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();

export async function register(req, res) {
  try {
    const { username, email, password } = req.body;
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);
    const user = new User({ username, email, passwordHash: hash });
    await user.save();
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
}

export async function login(req, res) {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });
    const matched = await bcrypt.compare(password, user.passwordHash);
    if (!matched) return res.status(400).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user._id, username: user.username } });
  } catch (err) { res.status(400).json({ error: err.message }); }
}
```

---

### backend/controllers/userController.js

```js
import User from '../models/User.js';

export async function follow(req, res) {
  try {
    const { userId, targetId } = req.body; // userId follows targetId
    if (userId === targetId) return res.status(400).json({ error: 'Invalid' });
    await User.findByIdAndUpdate(targetId, { $addToSet: { followers: userId } });
    await User.findByIdAndUpdate(userId, { $addToSet: { following: targetId } });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
}

export async function getFollowingVideos(req, res) {
  try {
    const userId = req.params.userId;
    const user = await User.findById(userId).select('following');
    const following = user.following || [];
    const Video = (await import('../models/Video.js')).default;
    const videos = await Video.find({ user: { $in: following } }).sort({ createdAt: -1 });
    res.json(videos);
  } catch (err) { res.status(400).json({ error: err.message }); }
}
```

---

### backend/controllers/videoController.js

```js
import Video from '../models/Video.js';
import User from '../models/User.js';
import multer from 'multer';
import fs from 'fs';

const upload = multer({ dest: 'uploads/' });

export { upload };

export async function uploadVideo(req, res) {
  try {
    const { title, userId } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file' });

    const video = new Video({ title, url: `/uploads/${file.filename}`, user: userId });
    await video.save();

    // notify followers using rooms
    const io = req.app.get('io');
    const user = await User.findById(userId).select('followers');
    (user.followers || []).forEach(f => io.to(`user_${f}`).emit('feed-update-following', video));

    res.json(video);
  } catch (err) { res.status(500).json({ error: err.message }); }
}

export async function getAllVideos(req, res) {
  const videos = await Video.find().sort({ createdAt: -1 }).limit(50);
  res.json(videos);
}

export async function likeVideo(req, res) {
  try {
    const video = await Video.findById(req.params.id);
    video.likes = (video.likes || 0) + 1;
    await video.save();
    res.json(video);
  } catch (err) { res.status(400).json({ error: err.message }); }
}

export async function getTrending(req, res) {
  const threshold = Number(process.env.TREND_THRESHOLD || 50);
  const videos = await Video.find({ likes: { $gte: threshold } }).sort({ likes: -1 }).limit(20);
  res.json(videos);
}
```

---

### backend/routes/authRoutes.js

```js
import express from 'express';
import { register, login } from '../controllers/authController.js';
const router = express.Router();
router.post('/register', register);
router.post('/login', login);
export default router;
```

---

### backend/routes/userRoutes.js

```js
import express from 'express';
import { follow, getFollowingVideos } from '../controllers/userController.js';
const router = express.Router();
router.post('/follow', follow);
router.get('/following-videos/:userId', getFollowingVideos);
export default router;
```

---

### backend/routes/videoRoutes.js

```js
import express from 'express';
import { upload, uploadVideo, getAllVideos, likeVideo, getTrending } from '../controllers/videoController.js';
const router = express.Router();
router.post('/upload', upload.single('video'), uploadVideo);
router.get('/' , getAllVideos);
router.post('/:id/like', likeVideo);
router.get('/trending', getTrending);
export default router;
```

---

### backend/trendingJob.js

```js
import Video from './models/Video.js';

export async function processTrending(io) {
  try {
    const threshold = Number(process.env.TREND_THRESHOLD || 50);
    const trending = await Video.find({ likes: { $gte: threshold } }).sort({ likes: -1 }).limit(10);
    trending.forEach(v => io.to('trending').emit('feed-update-trending', v));
  } catch (err) { console.error('Trending job error', err); }
}
```

---

## Frontend — Files

### frontend/package.json

```json
{
  "name": "tiktok-frontend",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "axios": "^1.4.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-router-dom": "^6.11.2",
    "socket.io-client": "^4.8.0"
  },
  "devDependencies": {
    "vite": "^5.1.0",
    "tailwindcss": "^4.0.0",
    "postcss": "^8.4.21",
    "autoprefixer": "^10.4.14"
  },
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  }
}
```

---

### frontend/tailwind.config.cjs

```js
module.exports = {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: { extend: {} },
  plugins: [],
};
```

---

### frontend/src/index.css

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

html, body, #root { height: 100%; }

/* small UI polish */
.video-card { @apply rounded-2xl overflow-hidden shadow-lg bg-black text-white; }
```

---

### frontend/src/socket.js

```js
import { io } from 'socket.io-client';
const socket = io(import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000');
export default socket;
```

---

### frontend/src/main.jsx

```jsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
```

---

### frontend/src/App.jsx

```jsx
import { Link, Routes, Route } from 'react-router-dom';
import Feed from './pages/Feed';
import FollowingFeed from './pages/FollowingFeed';
import TrendingFeed from './pages/TrendingFeed';
import Upload from './pages/Upload';
import Auth from './pages/Auth';
import Navbar from './components/Navbar';

export default function App(){
  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-900 via-black to-gray-800 text-white">
      <Navbar />
      <div className="container mx-auto px-4 py-6">
        <Routes>
          <Route path="/" element={<Feed/>} />
          <Route path="/following" element={<FollowingFeed/>} />
          <Route path="/trending" element={<TrendingFeed/>} />
          <Route path="/upload" element={<Upload/>} />
          <Route path="/auth" element={<Auth/>} />
        </Routes>
      </div>
    </div>
  );
}
```

---

### frontend/src/components/Navbar.jsx

```jsx
import { Link } from 'react-router-dom';
export default function Navbar(){
  return (
    <nav className="bg-black/60 backdrop-blur p-4 sticky top-0 z-30">
      <div className="container mx-auto flex items-center justify-between">
        <Link to="/" className="text-2xl font-bold">TikLite</Link>
        <div className="flex gap-4">
          <Link to="/following" className="hover:opacity-80">Following</Link>
          <Link to="/trending" className="hover:opacity-80">Trending</Link>
          <Link to="/upload" className="bg-white text-black px-3 py-1 rounded-full">Upload</Link>
        </div>
      </div>
    </nav>
  );
}
```

---

### frontend/src/components/VideoCard.jsx

```jsx
export default function VideoCard({ v }){
  return (
    <div className="video-card mb-6 p-4">
      <div className="aspect-video bg-black rounded-xl overflow-hidden">
        <video className="w-full h-full object-cover" src={`${import.meta.env.VITE_BACKEND_URL||'http://localhost:5000'}${v.url}`} controls playsInline />
      </div>
      <div className="mt-3 flex items-center justify-between">
        <div>
          <h3 className="font-bold">{v.title || 'Untitled'}</h3>
          <p className="text-sm text-gray-300">{v.likes} likes • {new Date(v.createdAt).toLocaleString()}</p>
        </div>
      </div>
    </div>
  );
}
```

---

### frontend/src/pages/Feed.jsx

```jsx
import { useEffect, useState } from 'react';
import axios from 'axios';
import VideoCard from '../components/VideoCard';
import socket from '../socket';

export default function Feed(){
  const [videos, setVideos] = useState([]);

  useEffect(()=>{
    axios.get(`${import.meta.env.VITE_BACKEND_URL||'http://localhost:5000'}/api/videos`).then(r=>setVideos(r.data));

    socket.on('feed-update-trending', v => setVideos(prev=>[v,...prev]));

    return ()=> socket.off('feed-update-trending');
  },[]);

  return (
    <div>
      <h2 className="text-xl mb-4">For you</h2>
      {videos.map(v => <VideoCard key={v._id} v={v} />)}
    </div>
  );
}
```

---

### frontend/src/pages/FollowingFeed.jsx

```jsx
import { useEffect, useState } from 'react';
import axios from 'axios';
import VideoCard from '../components/VideoCard';
import socket from '../socket';

// For demo, provide userId via localStorage after login
const getUserId = ()=> localStorage.getItem('userId');

export default function FollowingFeed(){
  const [videos, setVideos] = useState([]);
  const userId = getUserId();

  useEffect(()=>{
    if(!userId) return;
    axios.get(`${import.meta.env.VITE_BACKEND_URL||'http://localhost:5000'}/api/users/following-videos/${userId}`)
      .then(r=>setVideos(r.data));

    socket.emit('register', userId);
    socket.on('feed-update-following', v => setVideos(prev=>[v,...prev]));
    return ()=> socket.off('feed-update-following');
  },[userId]);

  if(!userId) return <div>Please login to see following feed (go to /auth)</div>;

  return (
    <div>
      <h2 className="text-xl mb-4">Following</h2>
      {videos.map(v => <VideoCard key={v._id} v={v} />)}
    </div>
  );
}
```

---

### frontend/src/pages/TrendingFeed.jsx

```jsx
import { useEffect, useState } from 'react';
import axios from 'axios';
import VideoCard from '../components/VideoCard';
import socket from '../socket';

export default function TrendingFeed(){
  const [videos, setVideos] = useState([]);
  useEffect(()=>{
    axios.get(`${import.meta.env.VITE_BACKEND_URL||'http://localhost:5000'}/api/videos/trending`).then(r=>setVideos(r.data));
    socket.on('feed-update-trending', v => setVideos(prev=>[v,...prev]));
    return ()=> socket.off('feed-update-trending');
  },[]);

  return (
    <div>
      <h2 className="text-xl mb-4">Trending</h2>
      {videos.map(v => <VideoCard key={v._id} v={v} />)}
    </div>
  );
}
```

---

### frontend/src/pages/Upload.jsx

```jsx
import { useState } from 'react';
import axios from 'axios';

export default function Upload(){
  const [title, setTitle] = useState('');
  const [file, setFile] = useState(null);

  const submit = async (e) =>{
    e.preventDefault();
    if(!file) return alert('Choose file');
    const form = new FormData();
    form.append('title', title);
    form.append('video', file);
    form.append('userId', localStorage.getItem('userId') || '');
    await axios.post(`${import.meta.env.VITE_BACKEND_URL||'http://localhost:5000'}/api/videos/upload`, form, { headers: {'Content-Type':'multipart/form-data'} });
    alert('Uploaded');
  }

  return (
    <form onSubmit={submit} className="max-w-md mx-auto p-6 bg-black/40 rounded-xl">
      <h2 className="text-lg mb-4">Upload</h2>
      <input className="w-full mb-3 p-2 rounded" placeholder="Title" value={title} onChange={e=>setTitle(e.target.value)} />
      <input className="w-full mb-3" type="file" accept="video/*" onChange={e=>setFile(e.target.files[0])} />
      <button className="bg-white text-black px-4 py-2 rounded">Upload</button>
    </form>
  );
}
```

---

### frontend/src/pages/Auth.jsx

```jsx
import axios from 'axios';
import { useState } from 'react';

export default function Auth(){
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [mode, setMode] = useState('login');

  const submit = async (e)=>{
    e.preventDefault();
    if(mode==='register'){
      await axios.post(`${import.meta.env.VITE_BACKEND_URL||'http://localhost:5000'}/api/auth/register`, { username, email, password });
      alert('Registered');
    } else {
      const res = await axios.post(`${import.meta.env.VITE_BACKEND_URL||'http://localhost:5000'}/api/auth/login`, { email, password });
      localStorage.setItem('token', res.data.token);
      localStorage.setItem('userId', res.data.user.id);
      alert('Logged in');
    }
  }

  return (
    <form onSubmit={submit} className="max-w-md mx-auto p-6 bg-black/40 rounded-xl">
      <h2 className="text-lg mb-4">{mode==='login'? 'Login' : 'Register'}</h2>
      {mode==='register' && <input className="w-full mb-3 p-2 rounded" placeholder="Username" value={username} onChange={e=>setUsername(e.target.value)} />}
      <input className="w-full mb-3 p-2 rounded" placeholder="Email" value={email} onChange={e=>setEmail(e.target.value)} />
      <input type="password" className="w-full mb-3 p-2 rounded" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)} />
      <button className="bg-white text-black px-4 py-2 rounded">{mode==='login'?'Login':'Register'}</button>
      <div className="mt-3 text-sm">
        <button type="button" onClick={()=>setMode(mode==='login'?'register':'login')}>Switch to {mode==='login'?'register':'login'}</button>
      </div>
    </form>
  );
}
```

---

## README / Run Instructions

1. Clone repo and `cd backend` then `npm install`. Create `.env` from `.env.example` and fill values.
2. Run Redis locally: `redis-server` (or use Docker `docker run -p 6379:6379 redis`).
3. Start backend: `npm run dev` (nodemon) or `npm start`.
4. `cd frontend` then `npm install` and create `.env` or use Vite's `VITE_BACKEND_URL` if needed.
5. Start frontend: `npm run dev` (Vite default port 5173).

Notes:
- Swap local uploads to S3 by replacing Multer storage with an S3 storage adapter.
- For production, run multiple backend instances behind a load balancer — Redis adapter ensures Socket.IO rooms work across instances.

---

## Final notes & next steps

- I focused on correctness, performance (rooms + Redis + cron), and a responsive Tailwind UI.
- If you want, I can:
  - Provide Docker Compose (Mongo + Redis + Node + Frontend). 
  - Replace uploads with S3 / Cloudinary code and signed uploads.
  - Add pagination / infinite scroll and better video playback (HLS).

---

*Open the code editor panel to view and copy individual files. If you'd like, I can now generate a `docker-compose.yml` and optional unit tests.*
