import { createContext, useContext, type PropsWithChildren } from "react";
import { useColorScheme } from "react-native";
import { useFonts } from "expo-font";
// The two weights the prototype uses, imported one by one so the other sixteen Fraunces files stay out of the bundle.
import { Fraunces_500Medium } from "@expo-google-fonts/fraunces/500Medium";
import { Fraunces_600SemiBold } from "@expo-google-fonts/fraunces/600SemiBold";
import { DARK, FONT, LIGHT, type Palette } from "./theme";

/** Light or dark follows the phone, as the prototype follows prefers-color-scheme. */
export function usePalette(): Palette {
  return useColorScheme() === "dark" ? DARK : LIGHT;
}

export interface Theme {
  p: Palette;
  /** Display font family: Fraunces once loaded, Georgia until then. */
  display: string;
  displayMedium: string;
  dark: boolean;
}

const ThemeContext = createContext<Theme | undefined>(undefined);

export function ThemeProvider({ children }: PropsWithChildren): React.JSX.Element {
  const p = usePalette();
  const [loaded] = useFonts({ Fraunces_500Medium, Fraunces_600SemiBold });
  const value: Theme = {
    p,
    display: loaded ? FONT.display : FONT.displayFallback,
    displayMedium: loaded ? FONT.displayMedium : FONT.displayFallback,
    dark: p.bg === "#121815",
  };
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const t = useContext(ThemeContext);
  if (!t) throw new Error("useTheme must be used inside ThemeProvider");
  return t;
}
