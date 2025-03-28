const express = require("express")
const app = express()
const http = require("http").createServer(app)
const { Server } = require("socket.io")
const io = new Server(http, {
  cors: {
    origin: "https://test.nexwey.online",
    methods: ["GET", "POST"],
    credentials: true,
  },
})
const cors = require("cors")
const mysql = require("mysql2/promise")
const bcrypt = require("bcrypt")
const multer = require("multer")
const path = require("path")
const fs = require("fs")

// Configuración de variables de entorno
require("dotenv").config()

// Allow all origins in Express CORS middleware
app.use(
  cors({
    origin: "https://test.nexwey.online",
    methods: ["GET", "POST"],
    credentials: true,
  }),
)
app.use(express.json())
app.use("/uploads", express.static(path.join(__dirname, "uploads")))

// Configuración de multer para el manejo de archivos
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "uploads")
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true })
    }
    cb(null, uploadDir)
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname))
  },
})

const upload = multer({ storage: storage })

// Configuración de la base de datos
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: "Q~Z#PZbNz]4",
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
})

// Verificar la conexión a la base de datos
const testConnection = async () => {
  try {
    const connection = await pool.getConnection()
    console.log("Database connected successfully")

    // Verificar que las tablas existen
    const [tables] = await connection.query("SHOW TABLES")
    console.log("Available tables:", tables)

    connection.release()
  } catch (err) {
    console.error("Database connection error:", err)
    console.log("Environment variables:", {
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      database: process.env.DB_NAME,
    })
  }
}

testConnection()

// Rutas de autenticación
app.post("/register", async (req, res) => {
  const { username, password } = req.body
  try {
    const hashedPassword = await bcrypt.hash(password, 10)
    const [result] = await pool.query("INSERT INTO users (username, password) VALUES (?, ?)", [
      username,
      hashedPassword,
    ])
    res.status(201).json({ message: "Usuario registrado exitosamente" })
  } catch (error) {
    res.status(500).json({ message: "Error en el registro", error: error.message })
  }
})

app.post("/login", async (req, res) => {
  const { username, password } = req.body
  try {
    const [rows] = await pool.query("SELECT * FROM users WHERE username = ?", [username])
    if (rows.length > 0) {
      const match = await bcrypt.compare(password, rows[0].password)
      if (match) {
        res.json({ userId: rows[0].id, username: rows[0].username })
      } else {
        res.status(401).json({ message: "Credenciales inválidas" })
      }
    } else {
      res.status(401).json({ message: "Usuario no encontrado" })
    }
  } catch (error) {
    res.status(500).json({ message: "Error en el login", error: error.message })
  }
})

// Ruta para obtener el histórico de mensajes
app.get("/messages/:roomId", async (req, res) => {
  const { roomId } = req.params
  try {
    console.log("Fetching messages for room ID/name:", roomId)
    const query = `
      SELECT m.*, u.username, r.name as room_name 
      FROM messages m 
      JOIN users u ON m.user_id = u.id 
      JOIN rooms r ON m.room_id = r.id 
      WHERE r.id = ? OR r.name = ? 
      ORDER BY m.created_at ASC 
      LIMIT 50
    `
    const [rows] = await pool.query(query, [roomId, roomId])
    console.log(`Found ${rows.length} messages for room ID/name ${roomId}`)
    res.json(rows)
  } catch (error) {
    console.error("Error al obtener mensajes:", error)
    res.status(500).json({ message: "Error al obtener mensajes", error: error.message })
  }
})

// Ruta para crear salas
app.post("/rooms", async (req, res) => {
  const { name } = req.body
  try {
    const [result] = await pool.query("INSERT INTO rooms (name) VALUES (?)", [name])
    res.status(201).json({ id: result.insertId, name })
  } catch (error) {
    res.status(500).json({ message: "Error al crear la sala", error: error.message })
  }
})

// Ruta para obtener salas
app.get("/rooms", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM rooms")
    res.json(rows)
  } catch (error) {
    res.status(500).json({ message: "Error al obtener las salas", error: error.message })
  }
})

// Ruta para obtener una sala específica
app.get("/rooms/:roomId", async (req, res) => {
  const { roomId } = req.params
  try {
    const [rows] = await pool.query("SELECT * FROM rooms WHERE id = ?", [roomId])
    if (rows.length > 0) {
      res.json(rows[0])
    } else {
      res.status(404).json({ message: "Sala no encontrada" })
    }
  } catch (error) {
    res.status(500).json({ message: "Error al obtener la sala", error: error.message })
  }
})

// Manejo de conexiones de socket
io.on("connection", (socket) => {
  console.log("Un usuario se ha conectado")

  socket.on("join room", (roomId) => {
    socket.join(roomId.toString())
    console.log(`Usuario unido a la sala ${roomId}`)
  })

  socket.on("leave room", (roomId) => {
    socket.leave(roomId.toString())
    console.log(`Usuario ha dejado la sala ${roomId}`)
  })

  socket.on("chat message", async (msg) => {
    try {
      const { userId, username, content, roomId, type } = msg
      console.log("Received message:", { userId, username, content, roomId, type })

      // Check if the user exists
      const [userExists] = await pool.query("SELECT id FROM users WHERE id = ?", [userId])
      if (userExists.length === 0) {
        console.error("User does not exist:", userId)
        return
      }

      // Check if the room exists, if not, create it
      let roomIdNumber
      const [roomExists] = await pool.query("SELECT id FROM rooms WHERE name = ?", [roomId])
      if (roomExists.length === 0) {
        const [newRoom] = await pool.query("INSERT INTO rooms (name) VALUES (?)", [roomId])
        roomIdNumber = newRoom.insertId
      } else {
        roomIdNumber = roomExists[0].id
      }

      const [result] = await pool.query("INSERT INTO messages (user_id, room_id, content, type) VALUES (?, ?, ?, ?)", [
        userId,
        roomIdNumber,
        content,
        type,
      ])

      const newMessage = {
        id: result.insertId,
        user_id: userId,
        username,
        room_id: roomIdNumber,
        content,
        type,
        created_at: new Date(),
      }
      console.log("Emitting new message:", newMessage)
      io.to(roomId.toString()).emit("chat message", newMessage)
    } catch (error) {
      console.error("Error al guardar el mensaje:", error)
    }
  })

  socket.on("disconnect", () => {
    console.log("Un usuario se ha desconectado")
  })
})

// Nueva ruta para subir imágenes
app.post("/upload", upload.single("image"), (req, res) => {
  if (req.file) {
    res.json({ filename: req.file.filename })
  } else {
    res.status(400).send("No se subió ningún archivo")
  }
})

// Endpoints de depuración
app.get("/debug/db", async (req, res) => {
  try {
    const connection = await pool.getConnection()
    const [tables] = await connection.query("SHOW TABLES")
    const [roomsCount] = await connection.query("SELECT COUNT(*) as count FROM rooms")
    const [messagesCount] = await connection.query("SELECT COUNT(*) as count FROM messages")

    res.json({
      status: "connected",
      tables,
      counts: {
        rooms: roomsCount[0].count,
        messages: messagesCount[0].count,
      },
    })

    connection.release()
  } catch (error) {
    res.status(500).json({
      status: "error",
      error: error.message,
    })
  }
})

app.get("/debug/rooms", async (req, res) => {
  try {
    const [rooms] = await pool.query("SELECT * FROM rooms")
    res.json(rooms)
  } catch (error) {
    res.status(500).json({
      error: error.message,
    })
  }
})

app.post("/check-user", async (req, res) => {
  const { userId, username } = req.body
  try {
    const [userExists] = await pool.query("SELECT id FROM users WHERE id = ?", [userId])
    if (userExists.length === 0) {
      // User doesn't exist, create a new one
      const [result] = await pool.query("INSERT INTO users (id, username) VALUES (?, ?)", [userId, username])
      res.status(201).json({ message: "User created", userId: result.insertId })
    } else {
      res.json({ message: "User exists", userId })
    }
  } catch (error) {
    console.error("Error checking/creating user:", error)
    res.status(500).json({ message: "Error checking/creating user", error: error.message })
  }
})

const PORT = process.env.PORT || 3000
http.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`)
})

