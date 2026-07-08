using UnityEngine;

public class PlayerController : MonoBehaviour {
    [SerializeField] private float moveSpeed = 5f;

    public void TakeDamage(int amount) {
        moveSpeed -= amount;
    }
}
