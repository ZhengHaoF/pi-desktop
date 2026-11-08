/// Pi Remote — mobile companion for Pi Agent Desktop.
///
/// ConnectPage (relay address + device id) → HomePage (PC 任务/空间, real
/// sessions.list grouped by project) → ProjectPage (per-project sessions +
/// 新建任务 via agent.new) → ChatPage (real session history, prompt, live
/// agent.events stream, approvals, abort).
library;

import 'package:flutter/material.dart';

import 'pages/connect_page.dart';

void main() {
  runApp(const PiRemoteApp());
}

class PiRemoteApp extends StatelessWidget {
  const PiRemoteApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Pi Remote',
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF534AB7)),
        scaffoldBackgroundColor: const Color(0xFFF7F7FA),
      ),
      home: const ConnectPage(),
    );
  }
}
