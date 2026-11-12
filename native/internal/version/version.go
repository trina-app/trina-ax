// Package version: the one version order of every updater (mycel-ctl, mycel-bootstrap, the server).
package version

import (
	"errors"
	"strconv"
	"strings"
)

// Compare orders versions exactly like server/src/system/update.ts compareVersions (the app's own updater,
// the installer's `admin.js compare-versions` and the release scripts): -1, 0, 1. Semver: numbers compare as numbers,
// a release is newer than its pre-releases, pre-release identifiers compare one by one (all-digit ones as numbers, so
// rc.10 is newer than rc.9; numeric before text; text by bytes; more identifiers newer when the rest is equal), build
// metadata (+...) is ignored. To give the same answer on every input, numbers are read the way JavaScript reads them:
// a part of the main version is its leading digits (parseInt, none = 0), an identifier is numeric only when it is all
// digits (/^\d+$/), and both become float64 like a JavaScript number. testdata/version-order.json is checked by both
// sides (TestCompareVersionsMatchesServer in cmd/mycel-ctl, tests/unit/g-update.test.ts there).
func Compare(a, b string) int {
	split := func(v string) ([]float64, []string) {
		core := strings.SplitN(v, "+", 2)[0]
		main, pre, hasPre := strings.Cut(core, "-")
		var nums []float64
		for _, x := range strings.Split(main, ".") {
			n, _ := jsNumber(x[:len(x)-len(strings.TrimLeft(x, "0123456789"))])
			nums = append(nums, n)
		}
		if !hasPre {
			return nums, nil
		}
		return nums, strings.Split(pre, ".")
	}
	xn, xp := split(a)
	yn, yp := split(b)
	for i := 0; i < len(xn) || i < len(yn); i++ {
		var p, q float64
		if i < len(xn) {
			p = xn[i]
		}
		if i < len(yn) {
			q = yn[i]
		}
		if p != q {
			if p < q {
				return -1
			}
			return 1
		}
	}
	if xp == nil || yp == nil {
		switch {
		case xp == nil && yp == nil:
			return 0
		case xp != nil:
			return -1
		default:
			return 1
		}
	}
	for i := 0; i < len(xp) || i < len(yp); i++ {
		if i >= len(xp) {
			return -1
		}
		if i >= len(yp) {
			return 1
		}
		p, q := xp[i], yp[i]
		if p == q {
			continue
		}
		pn, pok := jsNumber(p)
		qn, qok := jsNumber(q)
		switch {
		case pok && qok:
			if pn < qn {
				return -1
			}
			if pn > qn {
				return 1
			}
		case pok != qok:
			if pok {
				return -1
			}
			return 1
		default:
			if p < q {
				return -1
			}
			return 1
		}
	}
	return 0
}

// jsNumber reads an all-digit string as JavaScript's Number() does (the nearest float64); ok is false for "" and
// anything else.
func jsNumber(s string) (float64, bool) {
	if s == "" || strings.TrimLeft(s, "0123456789") != "" {
		return 0, false
	}
	n, err := strconv.ParseFloat(s, 64)
	return n, err == nil || errors.Is(err, strconv.ErrRange)
}
