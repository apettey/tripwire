<?php

// fork: notes are handed out sanitised whoever asks (password API, token API), so a row stored before the sanitiser
// existed never reaches an API client as markup that runs
require_once(__DIR__ . '/../../note-html.inc.php');

if (isset($_REQUEST['systemID']) && $maskID) {
    $query = 'SELECT * FROM comments WHERE systemID = :systemID AND maskID = :maskID';
    $stmt = $mysql->prepare($query);
    $stmt->bindValue(':systemID', $_REQUEST['systemID']);
    $stmt->bindValue(':maskID', $maskID);
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_CLASS);
    foreach ($rows as $row) {
      $row->created = date('Y-m-d H:i:s e', strtotime($row->created));
      $row->modified = date('Y-m-d H:i:s e', strtotime($row->modified));
      $row->comment = sanitizeNoteHtml($row->comment);
      $output[] = $row;
    }
} else if ($maskID) {
    $query = 'SELECT * FROM comments WHERE maskID = :maskID';
    $stmt = $mysql->prepare($query);
    $stmt->bindValue(':maskID', $maskID);
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_CLASS);
    foreach ($rows as $row) {
      $row->created = date('Y-m-d H:i:s e', strtotime($row->created));
      $row->modified = date('Y-m-d H:i:s e', strtotime($row->modified));
      $row->comment = sanitizeNoteHtml($row->comment);
      $output[] = $row;
    }
}
