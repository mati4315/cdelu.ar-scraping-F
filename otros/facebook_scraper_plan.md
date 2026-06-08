# Plan de Desarrollo: Web Scraper de Facebook (Node.js + MySQL)

Este documento detalla la arquitectura, el diseño y las estrategias para crear un scraper de Facebook robusto y a prueba de fallos, diseñado específicamente para ejecutarse en un entorno de hosting compartido (Hostinger).

---

## 1. Retos del Entorno y Arquitectura
**Entorno:** Hosting compartido de Hostinger.
**Consideración Crítica:** Los servidores compartidos tienen recursos muy limitados (RAM, CPU, procesos en segundo plano). Ejecutar navegadores completos como Puppeteer/Playwright suele causar caídas por falta de RAM o son bloqueados por el proveedor.

### Solución Arquitectónica Recomendada
Para que sea ligero, rápido y no consuma excesiva RAM, utilizaremos **Scraping HTTP directo** apuntando a la versión móvil básica de Facebook (`mbasic.facebook.com` o `m.facebook.com`).
* **Librerías principales:** `axios` (para peticiones a red), `cheerio` (para parsear el HTML), `mysql2` (para la base de datos).
* **Autenticación:** En lugar de hacer que el script inicie sesión (lo cual dispara alertas de seguridad en Facebook), extraerás las **Cookies de sesión** de tu navegador personal y las colocarás en el servidor para que el script navegue como si fueras tú.

---

## 2. Esquema de Base de Datos (MySQL)

Necesitarás crear una tabla en tu MySQL local (o el de Hostinger).

```sql
CREATE TABLE fb_posts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    post_id VARCHAR(50) UNIQUE NOT NULL, -- ID único de la publicación de Facebook
    author_name VARCHAR(100) NOT NULL,
    author_profile_pic TEXT,
    content TEXT,
    original_post_link TEXT NOT NULL,
    images JSON, -- Guardaremos un array de URLs de imágenes
    video_links JSON, -- Guardaremos un array de URLs de videos
    scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX(post_id)
);
```

---

## 3. Lógica Principal del Scraper

### 3.1 Flujo de Scraping
1. **Inicialización:** Cargar credenciales de MySQL y las Cookies de Facebook desde un archivo `.env` o `cookies.json`.
2. **Petición HTTP:** Hacer un GET a `https://mbasic.facebook.com/` (Home/Feed).
3. **Parseo (Cheerio):** Analizar el HTML en busca del contenedor principal de historias/publicaciones.
4. **Iteración por Publicaciones:** Recorrer cada publicación encontrada en el feed.

### 3.2 Filtrado: Excluir Publicaciones Compartidas
Para garantizar que **sólo** se guarden publicaciones originales, aplicaremos reglas de validación al HTML de cada post:
* **Detección de Sub-contenedores:** Si la publicación tiene un post anidado dentro de ella (clásica estructura de "Post A comparte Post B").
* **Keywords en el encabezado:** Si en el mismo elemento donde está el nombre del autor aparece texto como *"compartió"*, *"shared"*, *"publicación de"*.
* Si se cumple alguna de estas condiciones, **el post se descarta automáticamente**.

### 3.3 Extracción de Datos
Para los posts originales que pasen el filtro:
* **Usuario (Autor):** Se extrae el texto de la etiqueta `<a>` principal del encabezado.
* **Foto de Perfil:** Se busca el atributo `src` de la etiqueta `<img>` que se encuentra junto al nombre del autor.
* **Link Original:** Se ubica el botón o texto con la "fecha/hora" de la publicación, cuyo enlace (href) lleva directamente a la URL estática del post.
* **Imágenes y Videos:**
  * Se buscan etiquetas `<img>` dentro del cuerpo del post.
  * Para videos, mbasic.facebook no renderiza videos complejos, suele dejar un enlace directo (href) con un prefijo especial (ej. `/video_redirect/`). El script extraerá esos y los resolverá.

---

## 4. Estrategias de Robustez (A prueba de Fallos)

Un scraper para Facebook debe ser cuidadosamente diseñado o la cuenta será bloqueada en días.

1. **Retrasos Aleatorios (Human Behavior):**
   * El script NUNCA debe hacer peticiones consecutivas sin pausas.
   * Entre página y página, agregar una pausa aleatoria (`setTimeout(..., Math.random() * 5000 + 5000)` = entre 5 y 10 segundos).
2. **Rotación sutil de User-Agents:**
   * Usar un `User-Agent` estático que coincida EXACTAMENTE con el navegador de donde sacaste las cookies, pero cambiar ligeros parámetros de cabeceras HTTP para imitar navegadores reales (`Accept-Language`, `Sec-Fetch-Mode`, etc.).
3. **Manejo Exhaustivo de Errores (Resilience):**
   * Usar bloques `try/catch` globales.
   * Si Facebook devuelve un `HTTP 302` o `HTTP 403`, o si la página responde con el texto *"Inicia sesión para continuar"*, **cortar la ejecución inmediatamente**, guardar un log crítico (o enviar alerta por Telegram/Email) y detenerse para no bloquear la cuenta.
4. **Evitar Duplicados:**
   * Usar el `post_id` con queries del tipo `INSERT IGNORE` o un `SELECT` previo para no hacer procesos pesados ni descargas repetidas de cosas que ya guardaste.
5. **Control de Redundancia de Sesión:**
   * Renovar y guardar el estado de las Cookies actualizadas si Facebook envía headers `Set-Cookie` en la respuesta (es vital para mantener la sesión viva).

---

## 5. Implementación en Hostinger (Hosting Compartido)

1. **Setup Natiivo en cPanel / hPanel:**
   * Ve a "Configuración de Node.js" en Hostinger.
   * Crea una nueva aplicación apuntando al archivo `app.js` de tu script.
   * Define las variables de entorno allí (DB_HOST, DB_USER, DB_PASS).
2. **Ejecución vía Cron Jobs:**
   * En lugar de tener el script corriendo permanentemente consumiendo memoria (lo cual Hostinger matará eventualmente), diseña el script para que se ejecute 1 vez, haga el scraping de los primeros 10-20 posts, guarde en la DB y **se cierre (exit 0)**.
   * Configura un Cron Job en Hostinger que llame al script cada 30 o 60 minutos:
     ```bash
     /opt/alt/nodejs20/root/usr/bin/node /home/usuario/public_html/scraper/app.js
     ```
3. **Manejo de Archivos Pesados:**
   * En lugar de descargar y guardar las imágenes/videos en el almacenamiento de tu Hostinger (lo cual saturará tu plan), **guarda solo la dirección URL (link)** en la base de datos MySQL.
   * Si forzosamente necesitas descargar los archivos, implementa una carpeta temporal y programa borrados automáticos mediante otro Cron Job para no saturar tu Inode limit en Hostinger.

---

## 6. Resumen de Herramientas (Tech Stack)

* **Lenguaje:** Node.js (v18 o superior).
* **Dependencias / packages.json:**
  * `axios` (Peticiones con soporte para enviar y recibir cookies).
  * `cheerio` (Selección de DOM estilo jQuery, infinitamente más rápido y ligero que Puppeteer).
  * `mysql2/promise` (Conexión asíncrona a la DB).
  * `dotenv` (Variables de entorno).
* **Estructura de archivos:**
  * `app.js` (Punto de entrada)
  * `db.js` (Conexión y queries MySQL)
  * `scraper.js` (Lógica principal de Cheerio)
  * `helpers.js` (Funciones sleep, parseo de URLs, manejo de cookies)
  * `.env` (Credenciales)
