<?php
// Disable output buffering so the JSON response is sent immediately
if (function_exists('fastcgi_finish_request')) {
  header('Content-Type: application/json');
  echo json_encode(['status' => 'ok', 'time' => date('c')]);
  fastcgi_finish_request();
}

$command = 'cd /home/u692901087/domains/bot.cdelu.io/nodejs && nohup /opt/alt/alt-nodejs20/root/usr/bin/node app.js >> cron.log 2>&1 &';
exec($command);

if (!function_exists('fastcgi_finish_request')) {
  header('Content-Type: application/json');
  echo json_encode(['status' => 'ok', 'time' => date('c')]);
}
