const express = require("express")
const app = express()
const http = require("http")
const server = http.createServer(app)
const { Server } = require("socket.io")
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'https://test.nexwey.online/msg-to-msg/',
    methods: ["GET", "POST"],
    credentials: true,
  },
})
const mysql = require("mysql2/promise")
const cors = require("cors")
const bcrypt = require("bcrypt")
const multer = require("multer")
const path = require("path")
const fs = require("fs")

// Configuración de variables de entorno
require("dotenv").config()

// Configuración de CORS
const corsOptions = {
  origin: process.env.FRONTEND_URL || 'https://test.nexwey.online/msg-to-msg/',
  methods: ['GET', 'POST'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
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

// Database connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || '193.203.166.161',
  user: process.env.DB_USER || 'u685273696_chat_us',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'u685273696_chat_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
})

// Verificar la conexión a la base de datos
const testConnection = async () => {
  try {
    const connection = await pool.getConnection();
    console.log('Database connected successfully');
    
    // Verificar que las tablas existen
    const [tables] = await connection.query('SHOW TABLES');
    console.log('Available tables:', tables);
    
    connection.release();
  } catch (err) {
    console.error('Database connection error:', err);
    console.log('Environment variables:', {
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      database: process.env.DB_NAME
    });
  }
};

testConnection();

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

// Ruta para obtener mensajes
app.get("/messages/:roomId", async (req, res) => {
  const { roomId } = req.params;
  try {
    // Obtener el ID de la sala desde su nombre
    const [roomResult] = await pool.query(
      "SELECT id FROM rooms WHERE name = ?",
      [roomId]
    );

    if (roomResult.length === 0) {
      console.log('Room not found:', roomId);
      return res.status(404).json({ message: "Sala no encontrada" });
    }

    const roomDbId = roomResult[0].id;
    console.log(`Fetching messages for room ${roomId} (ID: ${roomDbId})`);

    const [messages] = await pool.query(
      `SELECT m.*, u.username 
       FROM messages m 
       JOIN users u ON m.user_id = u.id 
       JOIN rooms r ON m.room_id = r.id
       WHERE m.room_id = ? 
       ORDER BY m.created_at ASC 
       LIMIT 50`,
      [roomDbId]
    );

    // Transformar los mensajes para usar nombres de sala en lugar de IDs
    const formattedMessages = messages.map(msg => ({
      ...msg,
      room_id: roomId // Usar el nombre de la sala en lugar del ID
    }));

    console.log(`Found ${formattedMessages.length} messages`);
    res.json(formattedMessages);
  } catch (error) {
    console.error("Error al obtener mensajes:", error);
    res.status(500).json({ message: "Error al obtener mensajes", error: error.message });
  }
})

// Ruta para crear mensajes
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
    io.to(roomId).emit("chat message", {
      ...newMessage[0],
      room_id: roomId // Enviar el nombre de la sala en lugar del ID
    })

    res.status(201).json(newMessage[0])
  } catch (error) {
    console.error("Error al crear el mensaje:", error)
    res.status(500).json({ message: "Error al crear el mensaje", error: error.message })
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

// Endpoints de depuración
app.get("/debug/rooms", async (req, res) => {
  try {
    const [rooms] = await pool.query("SELECT * FROM rooms");
    res.json(rooms);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/debug/db", async (req, res) => {
  try {
    const [tables] = await pool.query('SHOW TABLES');
    const [roomsCount] = await pool.query('SELECT COUNT(*) as count FROM rooms');
    const [messagesCount] = await pool.query('SELECT COUNT(*) as count FROM messages');
    
    res.json({
      tables,
      counts: {
        rooms: roomsCount[0].count,
        messages: messagesCount[0].count
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Nueva ruta para subir imágenes
app.post("/upload", upload.single("image"), (req, res) => {
  if (req.file) {
    res.json({ filename: req.file.filename })
  } else {
    res.status(400).send("No se subió ningún archivo")
  }
})

// Manejo de conexiones de socket
io.on("connection", (socket) => {
  console.log("Usuario conectado:", socket.id);

  socket.on("join room", (roomId) => {
    socket.join(roomId);
    console.log(`Usuario ${socket.id} unido a la sala ${roomId}`);
  });

  socket.on("leave room", (roomId) => {
    socket.leave(roomId);
    console.log(`Usuario ha dejado la sala ${roomId}`);
  });

  socket.on("chat message", async (msg) => {
    try {
      console.log('Mensaje recibido:', msg);
      const { userId, username, content, roomId, type } = msg;
      
      // Validar datos requeridos
      if (!userId || !content || !roomId) {
        console.error('Datos de mensaje inválidos:', msg);
        return;
      }

      // Obtener el ID de la sala desde su nombre
      const [roomResult] = await pool.query(
        "SELECT id FROM rooms WHERE name = ?",
        [roomId]
      );

      if (roomResult.length === 0) {
        console.error('Room not found:', roomId);
        socket.emit("error", { message: "Sala no encontrada" });
        return;
      }

      const roomDbId = roomResult[0].id;
      console.log(`Room name ${roomId} maps to ID ${roomDbId}`);

      // Insertar el mensaje usando el ID de la sala
      const [result] = await pool.query(
        "INSERT INTO messages (user_id, room_id, content, type) VALUES (?, ?, ?, ?)",
        [userId, roomDbId, content, type || 'text']
      );

      // Obtener el mensaje recién creado con los datos del usuario
      const [newMessage] = await pool.query(
        `SELECT m.*, u.username 
         FROM messages m 
         JOIN users u ON m.user_id = u.id 
         WHERE m.id = ?`,
        [result.insertId]
      );

      console.log('Mensaje guardado:', newMessage[0]);
      
      // Emitir el mensaje usando el nombre de la sala para mantener consistencia con el cliente
      io.to(roomId).emit("chat message", {
        ...newMessage[0],
        room_id: roomId // Enviar el nombre de la sala en lugar del ID
      });

    } catch (error) {
      console.error("Error al guardar el mensaje:", error);
      socket.emit("error", { message: "Error al guardar el mensaje" });
    }
  });

  socket.on("disconnect", () => {
    console.log("Usuario desconectado:", socket.id);
  });
});

// Iniciar el servidor
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
