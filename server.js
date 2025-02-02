const express = require("express")
const app = express()
const http = require("http")
const server = http.createServer(app)
const { Server } = require("socket.io")
const io = new Server(server)
const mysql = require("mysql2/promise")
// ... other imports ...

// Database connection pool
const pool = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "",
  database: "chat_app",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
})

app.use(express.json())

app.post("/messages", async (req, res) => {
  try {
    const { userId, content, roomId, type } = req.body
    console.log("Received message:", { userId, content, roomId, type })

    // Verificar que el room existe
    const [roomResult] = await pool.query("SELECT id FROM rooms WHERE name = ?", [roomId])
    if (roomResult.length === 0) {
      return res.status(404).json({ message: "Room not found" })
    }
    const roomDbId = roomResult[0].id

    // Insertar el mensaje en la base de datos
    const [result] = await pool.query("INSERT INTO messages (user_id, room_id, content, type) VALUES (?, ?, ?, ?)", [
      userId,
      roomDbId,
      content,
      type || "text",
    ])

    // Obtener el mensaje recién creado
    const [newMessage] = await pool.query(
      "SELECT m.*, u.username FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = ?",
      [result.insertId],
    )

    console.log("New message created:", newMessage[0])

    // Emitir el mensaje a todos los clientes en la sala
    io.to(roomId).emit("chat message", newMessage[0])

    res.status(201).json(newMessage[0])
  } catch (error) {
    console.error("Error al crear el mensaje:", error)
    res.status(500).json({ message: "Error al crear el mensaje", error: error.message })
  }
})

server.listen(3001, () => {
  console.log("listening on *:3001")
})

