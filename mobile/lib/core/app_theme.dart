/// Shared design tokens and Material 3 theme for Pi Go.
library;

import 'package:flutter/material.dart';

/// Semantic color palette used across every mobile page and card.
abstract final class AppColors {
  static const Color brand = Color(0xFF534AB7);
  static const Color brandSoft = Color(0xFFEEECF9);
  static const Color brandBorder = Color(0xFFD5D1F0);
  static const Color brandInk = Color(0xFF3E3596);

  static const Color scaffoldBg = Color(0xFFF6F6FA);
  static const Color surface = Colors.white;
  static const Color surfaceMuted = Color(0xFFF1F1F6);
  static const Color surfaceSubtle = Color(0xFFFAFAFD);
  static const Color border = Color(0xFFE6E6EE);
  static const Color borderStrong = Color(0xFFD8D8E3);

  static const Color textPrimary = Color(0xFF18181F);
  static const Color textSecondary = Color(0xFF5A5A66);
  static const Color textMuted = Color(0xFF8C8C98);

  static const Color success = Color(0xFF15803D);
  static const Color successBg = Color(0xFFECFDF3);
  static const Color successBorder = Color(0xFFBBF7D0);

  static const Color warning = Color(0xFFB45309);
  static const Color warningBg = Color(0xFFFFFBEB);
  static const Color warningBorder = Color(0xFFFDE68A);

  static const Color danger = Color(0xFFDC2626);
  static const Color dangerBg = Color(0xFFFEF2F2);
  static const Color dangerBorder = Color(0xFFFECACA);
}

/// Application version displayed in Settings / About.
const String appDisplayVersion = '0.5.3';

/// Builds the unified light theme for Pi Go.
ThemeData buildAppTheme() {
  final scheme = ColorScheme.fromSeed(
    seedColor: AppColors.brand,
    surface: AppColors.surface,
  );
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: AppColors.scaffoldBg,
    appBarTheme: const AppBarTheme(
      backgroundColor: AppColors.surface,
      foregroundColor: AppColors.textPrimary,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0.5,
      centerTitle: false,
      titleTextStyle: TextStyle(
        color: AppColors.textPrimary,
        fontSize: 17,
        fontWeight: FontWeight.w700,
      ),
    ),
    dividerTheme: const DividerThemeData(
      color: AppColors.border,
      thickness: 1,
      space: 1,
    ),
    bottomSheetTheme: const BottomSheetThemeData(
      backgroundColor: AppColors.surface,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: AppColors.surface,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
    ),
  );
}
