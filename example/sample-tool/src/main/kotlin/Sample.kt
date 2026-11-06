package sample

/**
 * Calculates the wood a saw blade removes.
 *
 * This file belongs to a fixture and exists so that the generated reference
 * of the example site has something to document.
 */
object Kerf {
    /**
     * Returns the length of wood lost to the blade when a board is cut into
     * [pieces] pieces.
     *
     * @param kerf the width of the saw cut, in millimetres
     * @param pieces how many pieces the board is cut into
     */
    fun waste(kerf: Double, pieces: Int): Double = kerf * (pieces - 1)

    fun spacing(width: Double, pins: Int): Double = width / pins
}
