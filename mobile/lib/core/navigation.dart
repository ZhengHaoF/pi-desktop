/// 导航助手：把某个页面变成唯一的根页面。
library;

import 'package:flutter/material.dart';

/// 以 [page] 作为新的根页面推入，清空整个导航栈。
///
/// 连接成功、断开返回都要用它，而不是 `pushReplacement`——后者只替换当前
/// 那一层，栈底残留的旧页面会让首页变成「可返回」状态：AppBar 自动画出
/// 返回箭头，系统返回键还能退到一个连接早已断开的页面。
void pushAsRoot(BuildContext context, Widget page) {
  Navigator.of(context).pushAndRemoveUntil(
    MaterialPageRoute<void>(builder: (_) => page),
    (route) => false,
  );
}
