const fs = require('fs');
const path = require('path');

const inputFile = process.argv[2];
const cookiesFile = path.join(__dirname, '..', 'cookies.json');

try {
  const content = fs.readFileSync(inputFile, 'utf8').trim();
  
  if (!content) {
    console.error('❌ El archivo de entrada está vacío. Operación cancelada.');
    process.exit(1);
  }

  let newCookies;
  try {
    newCookies = JSON.parse(content);
  } catch (err) {
    console.error('❌ El texto pegado no es un JSON válido. Asegúrate de copiarlo completo.');
    console.error('Detalle del error:', err.message);
    process.exit(1);
  }

  if (!Array.isArray(newCookies)) {
    console.error('❌ El JSON pegado no tiene el formato correcto (debe ser una lista/array de cookies con corchetes [ ]).');
    process.exit(1);
  }

  // Lista de campos que queremos conservar de cada cookie
  const allowedFields = [
    'domain', 'expirationDate', 'hostOnly', 'httpOnly', 
    'name', 'path', 'sameSite', 'secure', 'session', 'storeId', 'value'
  ];
  
  const processedCookies = newCookies.map(cookie => {
    let cleanCookie = {};
    for (const key of allowedFields) {
      if (cookie[key] !== undefined) {
        cleanCookie[key] = cookie[key];
      }
    }
    return cleanCookie;
  });

  // Sobrescribir el archivo cookies.json local
  fs.writeFileSync(cookiesFile, JSON.stringify(processedCookies, null, 4), 'utf8');
  console.log(`✅ ${processedCookies.length} cookies procesadas y guardadas correctamente en cookies.json`);

} catch (error) {
  console.error('❌ Error inesperado:', error.message);
  process.exit(1);
}
