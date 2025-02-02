const express = require("express")
const app = express()
const http = require("http").createServer(app)
const io = require("socket.io")(http, {
  cors: {
    origin: "*", // Allow all origins
    methods: ["GET", "POST"],
    credentials: true
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
    origin: "*", // Allow all origins
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
  password: 'Q~Z#PZbNz]4',
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
})
//verificar la conexión a la base de datos y los datos de conexión
pool.getConnection((err, connection) => {
  if (err) {
    console.error("Error al conectar a la base de datos:", err)
    console.log("Verifica los datos de conexión en el archivo .env")
    
  } else {
    console.log("Conexión exitosa a la base de datos")
    connection.release()
  }
})

// Rutas de autenticación
// Endpoint temporal para verificar la conexión a la base de datos
app.get('/debug/db', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [tables] = await connection.query('SHOW TABLES');
    const [roomsCount] = await connection.query('SELECT COUNT(*) as count FROM rooms');
    const [messagesCount] = await connection.query('SELECT COUNT(*) as count FROM messages');
    
    res.json({
      status: 'connected',
      tables,
      counts: {
        rooms: roomsCount[0].count,
        messages: messagesCount[0].count
      }
    });
    
    connection.release();
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

// Endpoint temporal para verificar las salas
app.get('/debug/rooms', async (req, res) => {
  try {
    const [rooms] = await pool.query('SELECT * FROM rooms');
    res.json(rooms);
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});
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
    const [rows] = await pool.query(
      "SELECT m.*, u.username FROM messages m JOIN users u ON m.user_id = u.id WHERE m.room_id = ? ORDER BY m.created_at ASC LIMIT 50",
      [roomId],
    )
    res.json(rows)
  } catch (error) {
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

// Actualizar el evento de chat message para usar IDs de sala en lugar de nombres
io.on("connection", (socket) => {
  socket.on("chat message", async (msg) => {
    try {
      console.log("Mensaje recibido:", msg)
      const { userId, username, content, roomId, type } = msg

      // Validar datos requeridos
      if (!userId || !content || !roomId) {
        console.error("Datos de mensaje inválidos:", msg)
        return
      }

      // Obtener el ID de la sala desde su nombre
      const [roomResult] = await pool.query("SELECT id FROM rooms WHERE name = ?", [roomId])

      if (roomResult.length === 0) {
        console.error("Room not found:", roomId)
        socket.emit("error", { message: "Sala no encontrada" })
        return
      }

      const roomDbId = roomResult[0].id
      console.log(`Room name ${roomId} maps to ID ${roomDbId}`)

      // Insertar el mensaje usando el ID de la sala
      const [result] = await pool.query("INSERT INTO messages (user_id, room_id, content, type) VALUES (?, ?, ?, ?)", [
        userId,
        roomDbId,
        content,
        type || "text",
      ])

      // Obtener el mensaje recién creado con los datos del usuario
      const [newMessage] = await pool.query(
        `SELECT m.*, u.username 
       FROM messages m 
       JOIN users u ON m.user_id = u.id 
       WHERE m.id = ?`,
        [result.insertId],
      )

      console.log("Mensaje guardado:", newMessage[0])

      // Emitir el mensaje usando el nombre de la sala para mantener consistencia con el cliente
      io.to(roomId).emit("chat message", {
        ...newMessage[0],
        room_id: roomId, // Enviar el nombre de la sala en lugar del ID
      })
    } catch (error) {
      console.error("Error al guardar el mensaje:", error)
      socket.emit("error", { message: "Error al guardar el mensaje" })
    }
  })
})

// Actualizar la ruta de mensajes para usar IDs de sala
app.get("/messages/:roomId", async (req, res) => {
  const { roomId } = req.params
  try {
    // Obtener el ID de la sala desde su nombre
    const [roomResult] = await pool.query("SELECT id FROM rooms WHERE name = ?", [roomId])

    if (roomResult.length === 0) {
      console.log("Room not found:", roomId)
      return res.status(404).json({ message: "Sala no encontrada" })
    }

    const roomDbId = roomResult[0].id
    console.log(`Fetching messages for room ${roomId} (ID: ${roomDbId})`)

    const [messages] = await pool.query(
      `SELECT m.*, u.username 
       FROM messages m 
       JOIN users u ON m.user_id = u.id 
       JOIN rooms r ON m.room_id = r.id
       WHERE m.room_id = ? 
       ORDER BY m.created_at ASC 
       LIMIT 50`,
      [roomDbId],
    )

    // Transformar los mensajes para usar nombres de sala en lugar de IDs
    const formattedMessages = messages.map((msg) => ({
      ...msg,
      room_id: roomId, // Usar el nombre de la sala en lugar del ID
    }))

    console.log(`Found ${formattedMessages.length} messages`)
    res.json(formattedMessages)
  } catch (error) {
    console.error("Error al obtener mensajes:", error)
    res.status(500).json({ message: "Error al obtener mensajes", error: error.message })
  }
})

// Agregar un endpoint de depuración para verificar las salas
app.get("/debug/rooms", async (req, res) => {
  try {
    const [rooms] = await pool.query("SELECT * FROM rooms")
    res.json(rooms)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// Agregar un endpoint de depuración para verificar la estructura de la base de datos
app.get("/debug/db", async (req, res) => {
  try {
    const [tables] = await pool.query("SHOW TABLES")
    const [roomsCount] = await pool.query("SELECT COUNT(*) as count FROM rooms")
    const [messagesCount] = await pool.query("SELECT COUNT(*) as count FROM messages")

    res.json({
      tables,
      counts: {
        rooms: roomsCount[0].count,
        messages: messagesCount[0].count,
      },
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

server.listen(3000, () => {
  console.log("listening on *:3000")
})
