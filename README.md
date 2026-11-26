# POS Velas de Navidad

Punto de venta para celular (PWA instalable desde Chrome) para vender velas de Navidad.

- **Usuarias:** 3, todas con rol `admin` (venden, cambian precios, agregan productos y ajustan inventario).
- **Acceso:** correo + PIN de 4 dígitos, validado en el servidor, **una sola vez por celular**: la sesión queda abierta aunque se cierre la app o se apague el teléfono, y sin internet abre con los últimos datos guardados. Se cierra solo con “Cerrar sesión”, poniendo `activo` en FALSE en la hoja, o tras un año sin uso. 5 intentos fallidos bloquean 15 min.
- **Datos:** una hoja de Google Sheets (pestañas `usuarios`, `productos`, `ventas`, `movimientos`, `accesos`).
- **API:** Google Apps Script pegado en esa hoja (`apps-script/Code.gs`).
- **App:** archivos estáticos en `web/` (se pueden publicar en GitHub Pages o en cualquier hosting HTTPS).

## Qué hace (paso 1)
- Vender: tocar el producto, ajustar cantidad, medio de pago, cliente opcional, confirmar. El inventario baja en cada venta (con bloqueo para ventas simultáneas).
- Cambiar precio de lista (Productos → Editar) o solo para una venta (“cambiar precio” en el carrito).
- Agregar productos, registrar entradas y ajustes de inventario, desactivar productos.
- Informes: Hoy / Semana (lunes a domingo, con gráfico por día) / Total, por producto, por vendedora y por medio de pago. Lista de ventas del día con opción de anular (devuelve las unidades).
- Stock bajo: banner en la app y correo a las 3 cuando un producto cruza su stock mínimo.

## Clientes, fiado y WhatsApp (paso 2)
- **Clientes:** pestaña 👥 con nombre, celular y nota. Al vender se elige el cliente (opcional).
- **Fiado:** medio de pago "📝 Fiado" (exige cliente). El saldo de cada cliente = ventas fiadas no anuladas − abonos. En Clientes se ve el total por cobrar, el historial y se registran abonos.
- **WhatsApp:** después de cada venta o abono, botón para enviar la cuenta/recibo al WhatsApp del cliente (`wa.me`, número de Colombia +57). En clientes que deben, botón “Cobrar por WhatsApp”.
- **Estados de pedido:** al vender se elige ✅ Entregado ya / ⏳ En proceso. La pestaña 📦 Pedidos lista los pendientes (con contador), permite marcarlos entregados y avisar al cliente por WhatsApp. Ventas anteriores sin estado cuentan como entregadas; se pueden pasar a “en proceso” desde el historial del cliente o desde la lista de entregados en Pedidos.
- **Marcar fiado pagado:** en el historial del cliente, cada compra fiada tiene “✅ Marcar pagado”; registra un abono por su valor (sin pasar del saldo) con el medio de pago elegido.
- **Quitar productos:** Productos → Editar → “🗑️ Quitar producto” borra la fila del catálogo; las ventas pasadas conservan el nombre y siguen en los informes.
- **Archivo maestro:** los admin ven en Cuenta el enlace a la hoja de Google (solo abre para quien tenga permiso en Drive).
- Las pestañas `clientes` y `abonos` y la columna `cliente_id` de `ventas` se crean solas la primera vez que se usan.

## Instalación

### 1. Hoja y API (5 min)
1. Crea una hoja de Google Sheets nueva, por ejemplo “POS Velas”.
2. Menú **Extensiones → Apps Script**. Borra lo que haya y pega `apps-script/Code.gs`. Arriba, en `USUARIOS_INICIALES`, escribe el correo y nombre de cada usuaria (los correos no se guardan en este repositorio).
3. En ⚙️ Configuración del proyecto marca “Mostrar archivo de manifiesto appsscript.json” y reemplázalo con `apps-script/appsscript.json`.
4. Selecciona la función `setup` y presiona ▶ Ejecutar. Acepta los permisos.
   Se crean las pestañas, las 3 usuarias con un PIN aleatorio (en la pestaña `usuarios`) y el producto *Kit alumbrado* con 150 unidades, precio $35.000 y aviso a las 20.
5. **Implementar → Nueva implementación → Aplicación web**: Ejecutar como *Yo*, Acceso *Cualquier usuario*. Copia la URL que termina en `/exec`.

### 2. App
1. Pega esa URL en `web/config.js` (`API_URL`).
2. Publica la carpeta `web/` en un hosting HTTPS. Con GitHub Pages: Settings → Pages → Source: *GitHub Actions*; el flujo `.github/workflows/pages.yml` la publica en cada cambio de `web/` en la rama principal.

### 3. En cada celular
Abrir el enlace en Chrome → menú ⋮ → **Instalar app** / “Agregar a la pantalla principal”. Ingresar con el correo y el PIN. Cada una puede cambiar su PIN en *Cuenta*.

## Administración
- **PIN:** escribe un PIN de 4 dígitos en la columna `pin` de `usuarios`; al primer ingreso se reemplaza solo por su versión cifrada.
- **Usuarias:** agregar una fila en `usuarios` (`activo` = TRUE). Para quitar acceso, poner `activo` en FALSE. Rol `vendedor` = solo vende y ve informes.
- **Medios de pago:** constante `PAY_METHODS` en `Code.gs`.
- Si cambias `Code.gs`: Implementar → Gestionar implementaciones → editar → *Nueva versión* (la URL no cambia).

## Seguridad
- La página no contiene datos; todo pasa por la API con un token de sesión. Sin sesión la API responde `SESSION` y no entrega nada.
- `noindex` en la página y `robots.txt` con `Disallow: /`, `Referrer-Policy: no-referrer`, CSP restringida a la API de Google.
- Los textos que escriben las usuarias se neutralizan para que no se ejecuten como fórmulas en la hoja.
- No hay credenciales en este repositorio.

## Pruebas
```
cd test && node backend.test.js   # API completa contra un emulador de Apps Script
node e2e.js /tmp                  # recorrido en navegador móvil (requiere Playwright)
node orders.js /tmp                # pedidos en proceso/entregado y marcar fiado pagado
node fixes.test.js                # escenarios de la revisión: abonos parciales, precio viejo, ventas duplicadas, códigos
node resilience.js /tmp           # navegador: sin internet, precio cambiado, corte al cobrar
node persist.js                   # sesión permanente: reabrir, sin internet, cerrar sesión
```
